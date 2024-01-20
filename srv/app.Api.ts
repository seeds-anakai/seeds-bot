// AWS SDK - Bedrock Agent
import {
  BedrockAgentClient,
  GetIngestionJobCommand,
  IngestionJobStatus,
  StartIngestionJobCommand,
} from '@aws-sdk/client-bedrock-agent';

// AWS SDK - Bedrock Agent Runtime
import {
  BedrockAgentRuntimeClient,
  RetrieveAndGenerateCommand,
  RetrieveAndGenerateType,
  RetrievedReference,
} from '@aws-sdk/client-bedrock-agent-runtime';

// AWS SDK - DynamoDB
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

// AWS SDK - DynamoDB - Document Client
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';

// AWS SDK - S3
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

// AWS SDK - S3 Request Presigner
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// Slack - Bolt
import {
  AllMiddlewareArgs,
  App,
  AwsLambdaReceiver,
  BlockElementAction,
  KnownBlock,
} from '@slack/bolt';

// Slack - Types
import {
  AppMentionEventWithFiles,
  File,
  WebClient,
} from '@/types/slack';

// Environment Variables
const [slackBotToken, slackSigningSecret, knowledgeBaseId, dataSourceId, dataSourceBucketName, modelArn, sessionTableName, referenceTableName] = [
  process.env.SLACK_BOT_TOKEN,
  process.env.SLACK_SIGNING_SECRET,
  process.env.KNOWLEDGE_BASE_ID,
  process.env.DATA_SOURCE_ID,
  process.env.DATA_SOURCE_BUCKET_NAME,
  process.env.MODEL_ARN,
  process.env.SESSION_TABLE_NAME,
  process.env.REFERENCE_TABLE_NAME,
];

// AWS SDK - Bedrock Agent - Client
const bedrockAgent = new BedrockAgentClient();

// AWS SDK - Bedrock Agent Runtime - Client
const bedrockAgentRuntime = new BedrockAgentRuntimeClient();

// AWS SDK - DynamoDB - Client
const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient());

// AWS SDK - S3 - Client
const s3 = new S3Client();

// Slack - AWS Lambda Receiver
const receiver = new AwsLambdaReceiver({
  signingSecret: slackSigningSecret,
});

// Slack - App
const slack = new App({
  token: slackBotToken,
  receiver,
});

// Slack - App Mention Event Handler
slack.event('app_mention', async ({ client, event }: AllMiddlewareArgs & { event: AppMentionEventWithFiles }) => {
  if (!event.subtype) {
    if (!event.files) {
      await answer(
        client,
        event.channel,
        event.ts,
        event.thread_ts ?? event.ts,
        normalize(event.text),
      );
    } else {
      await uploadFilesAndSync(
        client,
        event.channel,
        event.ts,
        event.thread_ts ?? event.ts,
        event.files,
      );
    }
  }
});

// Slack - Direct Message Handler
slack.message(async ({ client, event }) => {
  if (!event.subtype) {
    if (!event.files) {
      await answer(
        client,
        event.channel,
        event.ts,
        event.thread_ts ?? event.ts,
        normalize(event.text ?? ''),
      );
    } else {
      await uploadFilesAndSync(
        client,
        event.channel,
        event.ts,
        event.thread_ts ?? event.ts,
        event.files,
      );
    }
  }

  if (event.subtype === 'file_share' && event.files) {
    await uploadFilesAndSync(
      client,
      event.channel,
      event.ts,
      event.thread_ts ?? event.ts,
      event.files,
    );
  }
});

// Slack - Open Reference Action Handler
slack.action('open_reference', async ({ client, body, ack }) => {
  await ack();

  if (body.type === 'block_actions') {
    await openReferenceModal(
      client,
      body.channel?.id ?? '',
      body.message?.ts ?? '',
      body.trigger_id,
      body.actions,
    );
  }
});

// Slack - Open Reference URL Action Handler
slack.action('open_reference_url', async ({ ack }) => {
  await ack();
});

// Answer
const answer = async (client: WebClient, channel: string, ts: string, threadTs: string, text: string): Promise<void> => {
  // Add emoji of thinking face.
  await client.reactions.add({
    name: 'thinking_face',
    channel,
    timestamp: ts,
  });

  try {
    // Retrieve and generate.
    const { sessionId, citations } = await bedrockAgentRuntime.send(new RetrieveAndGenerateCommand({
      sessionId: await getSessionId(channel, threadTs),
      input: {
        text,
      },
      retrieveAndGenerateConfiguration: {
        type: RetrieveAndGenerateType.KNOWLEDGE_BASE,
        knowledgeBaseConfiguration: {
          knowledgeBaseId,
          modelArn,
        },
      },
    }));

    if (!sessionId) {
      throw Error('回答の生成に失敗しました。');
    }

    if (!citations) {
      throw Error('回答の生成に失敗しました。');
    }

    // References
    const references = citations.flatMap(({ retrievedReferences }) => retrievedReferences ?? []);

    // Answer
    const answer = citations.reduce((answer, { generatedResponsePart, retrievedReferences }) => {
      // Add response text.
      answer += generatedResponsePart?.textResponsePart?.text;

      // Add reference numbers.
      answer += retrievedReferences?.map?.((reference) => {
        return `[${references.indexOf(reference) + 1}] `;
      })?.join?.('');

      // Answer
      return answer;
    }, '');

    // Post message in thread.
    const messageId = await postMessage(client, channel, threadTs, answer, references);

    // Put session id.
    await putSessionId(channel, threadTs, sessionId);

    // Put references.
    await putReferences(messageId, references);
  } catch (e: any) {
    // Post error message in thread.
    await postMessage(client, channel, threadTs, e.message);
  } finally {
    // Remove emoji of thinking face.
    await client.reactions.remove({
      name: 'thinking_face',
      channel,
      timestamp: ts,
    });
  }
};

// Upload Files and Sync
const uploadFilesAndSync = async (client: WebClient, channel: string, ts: string, threadTs: string, files: File[]): Promise<void> => {
  // Add emoji of saluting face.
  await client.reactions.add({
    name: 'saluting_face',
    channel,
    timestamp: ts,
  });

  try {
    // Put files.
    await putFiles(files);

    // Start ingestion job.
    const ingestionJobId = await startIngestionJob(
      knowledgeBaseId,
      dataSourceId,
    );

    if (!ingestionJobId) {
      throw Error('データの取り込みに失敗しました。');
    }

    while (true) {
      // Get ingestion job status.
      const status = await getIngestionJobStatus(
        knowledgeBaseId,
        dataSourceId,
        ingestionJobId,
      );

      if (!status) {
        throw Error('データの取り込みに失敗しました。');
      }

      if (status === 'FAILED') {
        throw Error('データの取り込みに失敗しました。');
      }

      if (status === 'COMPLETE') {
        break;
      }

      await new Promise((resolve) => {
        setTimeout(resolve, 3000);
      });
    }

    // Post message in thread.
    await postMessage(client, channel, threadTs, 'データの取り込みに成功しました。');
  } catch (e: any) {
    // Post error message in thread.
    await postMessage(client, channel, threadTs, e.message);
  } finally {
    // Remove emoji of saluting face.
    await client.reactions.remove({
      name: 'saluting_face',
      channel,
      timestamp: ts,
    });
  }
};

// Open Reference Modal
const openReferenceModal = async (client: WebClient, channel: string, ts: string, triggerId: string, actions: BlockElementAction[]): Promise<void> => {
  await Promise.all(actions.flatMap((action) => action.type === 'button' ? [action] : []).map(async ({ value }) => {
    // Message ID
    const messageId = `${channel}-${ts}`;

    // Get reference.
    const reference = isFinite(Number(value))
      ? await getReference(messageId, Number(value))
      : JSON.parse(value) as RetrievedReference;

    if (!reference) {
      return;
    }

    if (!reference.location?.s3Location?.uri) {
      return;
    }

    if (!reference.content?.text) {
      return;
    }

    // Content Text and S3 Location URI
    const { content: { text }, location: { s3Location: { uri } } } = reference;

    // File Name
    const fileName = getFileNameFromUri(uri);

    // URL
    const url = await getSignedUrl(s3, new GetObjectCommand({
      Bucket: dataSourceBucketName,
      Key: getPathNameFromUri(uri),
    }));

    // Open reference modal.
    await client.views.open({
      trigger_id: triggerId,
      view: {
        type: 'modal',
        title: {
          type: 'plain_text',
          text: omit(fileName, 24),
        },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: omit(`*${fileName}*`, 3000),
            },
            accessory: {
              type: 'button',
              action_id: 'open_reference_url',
              text: {
                type: 'plain_text',
                text: '開く',
              },
              url,
            },
          },
          {
            type: 'section',
            text: {
              type: 'plain_text',
              text: omit(text, 3000),
            },
          },
        ],
      },
    });
  }));
};

// Get Session ID
const getSessionId = async (channel: string, threadTs: string): Promise<string | undefined> => {
  const { Item: item } = await dynamodb.send(new GetCommand({
    TableName: sessionTableName,
    Key: {
      channel,
      threadTs,
    },
  }));

  return item?.sessionId;
};

// Put Session ID
const putSessionId = async (channel: string, threadTs: string, sessionId: string): Promise<void> => {
  const ttl = Math.floor(Date.now() / 1000) + 60 * 60 * 24;

  await dynamodb.send(new PutCommand({
    TableName: sessionTableName,
    Item: {
      channel,
      threadTs,
      sessionId,
      ttl,
    },
  }));
};

// Get Reference
const getReference = async (messageId: string, no: number): Promise<RetrievedReference | undefined> => {
  const { Item: item } = await dynamodb.send(new GetCommand({
    TableName: referenceTableName,
    Key: {
      messageId,
      no,
    },
  }));

  return item?.reference;
};

// Put References
const putReferences = async (messageId: string, references: RetrievedReference[]): Promise<void> => {
  await Promise.all(splitArrayEqually(references, 25).map((references, i) => {
    return dynamodb.send(new BatchWriteCommand({
      RequestItems: {
        [referenceTableName]: references.map((reference, j) => ({
          PutRequest: {
            Item: {
              messageId,
              no: i * 25 + j + 1,
              reference,
            },
          },
        })),
      },
    }));
  }));
};

// Start Ingestion Job
const startIngestionJob = async (knowledgeBaseId: string, dataSourceId: string): Promise<string | undefined> => {
  const { ingestionJob } = await bedrockAgent.send(new StartIngestionJobCommand({
    knowledgeBaseId,
    dataSourceId,
  }));

  return ingestionJob?.ingestionJobId;
};

// Get Ingestion Job Status
const getIngestionJobStatus = async (knowledgeBaseId: string, dataSourceId: string, ingestionJobId: string): Promise<IngestionJobStatus | undefined> => {
  const { ingestionJob } = await bedrockAgent.send(new GetIngestionJobCommand({
    knowledgeBaseId,
    dataSourceId,
    ingestionJobId,
  }));

  return ingestionJob?.status;
};

// Put Files
const putFiles = async (files: File[]): Promise<void> => {
  await Promise.all(files.map(async ({ name, mimetype, user, url_private_download: urlPrivateDownload }) => {
    if (name && mimetype && user && urlPrivateDownload) {
      const response = await fetch(urlPrivateDownload, {
        headers: {
          Authorization: `Bearer ${slackBotToken}`,
        },
      });

      // Body
      const body = Buffer.from(await response.arrayBuffer());

      await s3.send(new PutObjectCommand({
        Bucket: dataSourceBucketName,
        Key: `users/${user}/${name}`,
        ContentType: mimetype,
        Body: body,
      }));
    }
  }));
};

// Post Message
const postMessage = async (client: WebClient, channel: string, threadTs: string, text: string, references: RetrievedReference[] = []): Promise<string> => {
  // Blocks
  const blocks: KnownBlock[] = [
    {
      type: 'section',
      text: {
        type: 'plain_text',
        text,
      },
    },
  ];

  // Add divider block if references exists.
  if (references.length) {
    blocks.push({
      type: 'divider',
    });
  }

  // Add reference blocks.
  references.map(({ location }, i) => `[${i + 1}] ${getFileNameFromUri(location?.s3Location?.uri ?? '')}`).forEach((text, i) => {
    blocks.push({
      type: 'section',
      text: {
        type: 'plain_text',
        text,
      },
      accessory: {
        type: 'button',
        action_id: 'open_reference',
        text: {
          type: 'plain_text',
          text: '詳細を見る',
        },
        value: String(i + 1),
      },
    });
  });

  // Post message.
  const { ts } = await client.chat.postMessage({
    channel,
    text,
    blocks,
    thread_ts: threadTs,
  });

  // Message ID
  return `${channel}-${ts}`;
};

// Normalize
const normalize = (text: string): string => {
  return text.replace(/<[!#@].*?>\s*/g, '');
};

// Omit
const omit = (text: string, length: number, ellipsis: string = '…'): string => {
  return text.length > length ? text.substring(0, length - 1) + ellipsis : text;
};

// Split Array Equally
const splitArrayEqually = <T>(array: T[], length: number): T[][] => {
  return [...Array(Math.ceil(array.length / length))].map((_, i) => {
    return array.slice(i * length, (i + 1) * length);
  });
};

// Get File Name from URI
const getFileNameFromUri = (uri: string): string => {
  return uri.split('/').slice(-1)[0] ?? '';
};

// Get Path Name from URI
const getPathNameFromUri = (uri: string): string => {
  return uri.split('/').slice(3).join('/');
};

// Lambda Handler
export const handler: ReturnType<typeof receiver.toHandler> = async (event, context, callback) => {
  if (event.headers['x-slack-retry-num']) {
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'OK',
      }),
    };
  }

  return await receiver.start().then((handler) => {
    return handler(event, context, callback);
  });
};
