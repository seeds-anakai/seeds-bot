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
  SayFn,
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
app.event('app_mention', async ({ client, event, say }) => {
  await answer(
    client,
    event.channel,
    event.ts,
    event.thread_ts ?? event.ts,
    normalize(event.text),
    say,
  );
});

// Slack - Message Handler
app.event('message', async ({ client, event, say }) => {
  if (!event.subtype && event.text) {
    await answer(
      client,
      event.channel,
      event.ts,
      event.thread_ts ?? event.ts,
      normalize(event.text),
      say,
    );
  }
});

// Answer
const answer = async (client: WebClient, channel: string, ts: string, threadTs: string, text: string, say: SayFn) => {
  // Thread ID
  const threadId = `${channel}#${threadTs}`;

  // Add emoji of thinking face.
  await client.reactions.add({
    name: 'thinking_face',
    channel,
    timestamp: ts,
  });

  // Retrieve and generate.
  const { sessionId, output } = await bedrock.send(new RetrieveAndGenerateCommand({
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

  // Say answer in thread.
  await say({ text: output?.text, thread_ts: threadTs });

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
const normalize = (text: string) => text.replace(/<[!#@].*?>/g, '').trim();

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
export const handler = async (event: any, context: any, callback: any): Promise<any> => {
  if (!event.headers['x-slack-retry-num']) {
    return await receiver.start().then((handler) => handler(event, context, callback));
  }
};
