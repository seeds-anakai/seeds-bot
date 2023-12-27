// AWS SDK - Bedrock Agent Runtime
import {
  BedrockAgentRuntimeClient,
  RetrieveAndGenerateCommand,
  RetrieveAndGenerateType,
} from '@aws-sdk/client-bedrock-agent-runtime';

// AWS SDK - DynamoDB
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

// AWS SDK - DynamoDB - Document Client
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';

// Slack - Bolt
import {
  App,
  AwsLambdaReceiver,
  DividerBlock,
  SectionBlock,
} from '@slack/bolt';

// Slack - Web API
import { WebClient } from '@slack/web-api';

// Environment Variables
const [slackBotToken, slackSigningSecret, sessionTableName, knowledgeBaseId, modelArn] = [
  process.env.SLACK_BOT_TOKEN,
  process.env.SLACK_SIGNING_SECRET,
  process.env.SESSION_TABLE_NAME,
  process.env.KNOWLEDGE_BASE_ID,
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

// Slack - App Mention Handler
app.event('app_mention', async ({ client, event }) => {
  await answer(
    client,
    event.channel,
    event.ts,
    event.thread_ts ?? event.ts,
    normalize(event.text),
  );
});

// Slack - Message Handler
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

  if (body.type === 'block_actions' && body.actions[0].type === 'button') {
    // Reference
    const { content, location } = JSON.parse(body.actions[0].value);

    // Location URI
    const uri = location?.s3Location?.uri?.split?.('/')?.pop?.() ?? '';

    // Open reference modal.
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        title: {
          type: 'plain_text',
          text: uri.length > 24 ? `${uri.substring(0, 23)}…` : uri,
        },
        blocks: [
          {
            type: 'header',
            text: {
              type: 'plain_text',
              text: uri,
            },
          },
          {
            type: 'section',
            text: {
              type: 'plain_text',
              text: content?.text ?? '',
            },
          },
        ],
      },
    });
  }
});

// Answer
const answer = async (client: WebClient, channel: string, ts: string, threadTs: string, text: string): Promise<void> => {
  // Thread ID
  const threadId = `${channel}#${threadTs}`;

  // Add emoji of thinking face.
  await client.reactions.add({
    name: 'thinking_face',
    channel,
    timestamp: ts,
  });

  // Retrieve and generate.
  const { sessionId, citations } = await bedrock.send(new RetrieveAndGenerateCommand({
    sessionId: await getSessionId(threadId),
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

  // Answer Blocks
  const blocks: [SectionBlock, DividerBlock, ...SectionBlock[]] = [
    {
      type: 'section',
      text: {
        type: 'plain_text',
        text: '',
      },
    },
    {
      type: 'divider',
    },
  ];

  // Add answer blocks.
  citations?.forEach?.(({ generatedResponsePart, retrievedReferences }) => {
    Object.assign(blocks[0], {
      text: {
        type: 'plain_text',
        text: `${blocks[0].text?.text}${generatedResponsePart?.textResponsePart?.text}`,
      },
    });

    // Add references.
    retrievedReferences?.forEach?.(({ content, location }) => {
      // Reference No
      const referenceNo = blocks.length - 1;

      Object.assign(blocks[0], {
        text: {
          type: 'plain_text',
          text: `${blocks[0].text?.text}[${referenceNo}] `,
        },
      });

      blocks.push({
        type: 'section',
        text: {
          type: 'plain_text',
          text: `[${referenceNo}] ${location?.s3Location?.uri?.split?.('/')?.pop?.()}`,
        },
        accessory: {
          type: 'button',
          text: {
            type: 'plain_text',
            text: '詳細を見る',
          },
          value: JSON.stringify({
            content: {
              text: content?.text?.substring?.(0, 1932 - JSON.stringify(location?.s3Location?.uri).length - (JSON.stringify(content.text).length - content.text.length)),
            },
            location,
          }),
          action_id: 'open_reference',
        },
      });
    });
  });

  // Post answer in thread.
  await client.chat.postMessage({
    channel,
    blocks,
    thread_ts: threadTs,
  });

  // Save session id.
  await dynamodb.send(new PutCommand({
    TableName: sessionTableName,
    Item: {
      threadId,
      sessionId,
    },
  }));

  // Remove emoji of thinking face.
  await client.reactions.remove({
    name: 'thinking_face',
    channel,
    timestamp: ts,
  });
};

// Normalize
const normalize = (text: string): string => {
  return text.replace(/<[!#@].*?>\s*/g, '');
};

// Get Session ID
const getSessionId = async (threadId: string): Promise<string | undefined> => {
  const { Item: item } = await dynamodb.send(new GetCommand({
    TableName: sessionTableName,
    Key: {
      threadId,
    },
  }));

  return item?.sessionId;
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
