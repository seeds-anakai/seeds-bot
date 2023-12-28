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

// Slack - Bolt
import {
  App,
  AwsLambdaReceiver,
  BlockElementAction,
  KnownBlock,
} from '@slack/bolt';

// Slack - Web API
import { WebClient } from '@slack/web-api';

// Environment Variables
const [slackBotToken, slackSigningSecret, knowledgeBaseId, sessionTableName, referenceTableName, modelArn] = [
  process.env.SLACK_BOT_TOKEN,
  process.env.SLACK_SIGNING_SECRET,
  process.env.KNOWLEDGE_BASE_ID,
  process.env.SESSION_TABLE_NAME,
  process.env.REFERENCE_TABLE_NAME,
  'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-v2',
];

// AWS SDK - Bedrock Agent Runtime - Client
const bedrock = new BedrockAgentRuntimeClient({
  apiVersion: '2023-07-26',
});

// AWS SDK - DynamoDB - Client
const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({
  apiVersion: '2012-08-10',
}));

// Slack - AWS Lambda Receiver
const receiver = new AwsLambdaReceiver({
  signingSecret: slackSigningSecret,
});

// Slack - App
const app = new App({ token: slackBotToken, receiver });

// Slack - App Mention Event Handler
app.event('app_mention', async ({ client, event }) => {
  if (!event.subtype) {
    await answer(
      client,
      event.channel,
      event.ts,
      event.thread_ts ?? event.ts,
      normalize(event.text),
    );
  }
});

// Slack - Direct Message Handler
app.message(async ({ client, event }) => {
  if (!event.subtype && event.text) {
    await answer(
      client,
      event.channel,
      event.ts,
      event.thread_ts ?? event.ts,
      normalize(event.text),
    );
  }
});

// Slack - Open Reference Action Handler
app.action('open_reference', async ({ client, body, ack }) => {
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

// Answer
const answer = async (client: WebClient, channel: string, ts: string, threadTs: string, text: string): Promise<void> => {
  // Add emoji of thinking face.
  await client.reactions.add({
    name: 'thinking_face',
    channel,
    timestamp: ts,
  });

  // Retrieve and generate.
  const { sessionId, citations } = await bedrock.send(new RetrieveAndGenerateCommand({
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

  if (!sessionId || !citations) {
    return;
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

  // Post answer in thread.
  const messageId = await postMessage(client, channel, threadTs, answer, references);

  // Put session id.
  await putSessionId(channel, threadTs, sessionId);

  // Put references.
  await putReferences(messageId, references);

  // Remove emoji of thinking face.
  await client.reactions.remove({
    name: 'thinking_face',
    channel,
    timestamp: ts,
  });
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

    // Filename
    const filename = getFilename(uri);

    // Open reference modal.
    await client.views.open({
      trigger_id: triggerId,
      view: {
        type: 'modal',
        title: {
          type: 'plain_text',
          text: omit(filename, 24),
        },
        blocks: [
          {
            type: 'header',
            text: {
              type: 'plain_text',
              text: filename,
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
  await dynamodb.send(new PutCommand({
    TableName: sessionTableName,
    Item: {
      channel,
      threadTs,
      sessionId,
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
  await Promise.all([...Array(Math.ceil(references.length / 25)).keys()].map((i) => references.slice(i * 25, (i + 1) * 25)).map((references, i) => {
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

// Post Message
const postMessage = async (client: WebClient, channel: string, threadTs: string, text: string, references: RetrievedReference[]): Promise<string> => {
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

  // Add divider block.
  if (references.length) {
    blocks.push({
      type: 'divider',
    });
  }

  // Add reference blocks.
  references.map(({ location }, i) => `[${i + 1}] ${getFilename(location?.s3Location?.uri ?? '')}`).forEach((text, i) => {
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

// Get Filename
const getFilename = (uri: string): string => {
  return uri.split('/').pop() ?? '';
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
