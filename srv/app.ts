// AWS CDK
import {
  App,
  CfnOutput,
  Duration,
  Stack,
  StackProps,
  aws_dynamodb as dynamodb,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_lambda_nodejs as nodejs,
} from 'aws-cdk-lib';

// Constructs
import { Construct } from 'constructs';

/**
 * A root construct which represents a single CloudFormation stack.
 */
class SeedsBotStack extends Stack {
  /**
   * Creates a new stack.
   *
   * @param scope Parent of this stack, usually an `App` or a `Stage`, but could be any construct.
   * @param id The construct ID of this stack. If `stackName` is not explicitly
   * defined, this id (and any parent IDs) will be used to determine the
   * physical ID of the stack.
   * @param props Stack properties.
   */
  constructor(scope?: Construct, id?: string, props?: StackProps) {
    super(scope, id, props);

    // Context Values
    const [slackBotToken, slackSigningSecret, knowledgeBaseId, dataSourceId, dataSourceBucketName, githubRepo] = [
      this.node.getContext('slackBotToken'),
      this.node.getContext('slackSigningSecret'),
      this.node.getContext('knowledgeBaseId'),
      this.node.getContext('dataSourceId'),
      this.node.getContext('dataSourceBucketName'),
      this.node.getContext('githubRepo'),
    ];

    // Api
    const api = new nodejs.NodejsFunction(this, 'Api', {
      architecture: lambda.Architecture.ARM_64,
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: Duration.minutes(15),
      memorySize: 1769, // 1 vCPU
      environment: {
        SLACK_BOT_TOKEN: slackBotToken,
        SLACK_SIGNING_SECRET: slackSigningSecret,
        KNOWLEDGE_BASE_ID: knowledgeBaseId,
        DATA_SOURCE_ID: dataSourceId,
        DATA_SOURCE_BUCKET_NAME: dataSourceBucketName,
        TZ: 'Asia/Tokyo',
      },
      initialPolicy: [
        new iam.PolicyStatement({
          actions: [
            'bedrock:AssociateThirdPartyKnowledgeBase',
            'bedrock:GetIngestionJob',
            'bedrock:InvokeModel',
            'bedrock:Retrieve',
            'bedrock:RetrieveAndGenerate',
            'bedrock:StartIngestionJob',
          ],
          resources: [
            '*',
          ],
        }),
        new iam.PolicyStatement({
          actions: [
            's3:PutObject',
          ],
          resources: [
            `arn:aws:s3:::${dataSourceBucketName}/*`,
          ],
        }),
      ],
      bundling: {
        minify: true,
        nodeModules: [
          '@aws-sdk/client-bedrock-agent',
          '@aws-sdk/client-bedrock-agent-runtime',
        ],
      },
    });

    // Add function url to Api.
    const { url: apiEndpoint } = api.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    });

    // Api Endpoint
    new CfnOutput(this, 'ApiEndpoint', {
      value: apiEndpoint,
    });

    // Session Table
    const sessionTable = new dynamodb.Table(this, 'SessionTable', {
      partitionKey: {
        name: 'channel',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'threadTs',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
    });

    // Add environment variable for access Session Table.
    api.addEnvironment('SESSION_TABLE_NAME', sessionTable.tableName);

    // Add permissions to access Session Table.
    sessionTable.grantReadWriteData(api);

    // Reference Table
    const referenceTable = new dynamodb.Table(this, 'ReferenceTable', {
      partitionKey: {
        name: 'messageId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'no',
        type: dynamodb.AttributeType.NUMBER,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    // Add environment variable for access Reference Table.
    api.addEnvironment('REFERENCE_TABLE_NAME', referenceTable.tableName);

    // Add permissions to access Reference Table.
    referenceTable.grantReadWriteData(api);

    // GitHub OpenID Connect Provider
    const githubOpenIdConnectProvider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(this, 'GitHubOpenIdConnectProvider', `arn:aws:iam::${this.account}:oidc-provider/token.actions.githubusercontent.com`);

    // GitHub Deploy Role
    new iam.Role(this, 'GitHubDeployRole', {
      assumedBy: new iam.WebIdentityPrincipal(githubOpenIdConnectProvider.openIdConnectProviderArn, {
        StringEquals: {
          [`${githubOpenIdConnectProvider.openIdConnectProviderIssuer}:aud`]: 'sts.amazonaws.com',
        },
        StringLike: {
          [`${githubOpenIdConnectProvider.openIdConnectProviderIssuer}:sub`]: `repo:${githubRepo}:*`,
        },
      }),
      inlinePolicies: {
        GitHubDeployRolePolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                'sts:AssumeRole',
              ],
              resources: [
                `arn:aws:iam::${this.account}:role/cdk-${this.synthesizer.bootstrapQualifier}-*-role-${this.account}-${this.region}`,
              ],
            }),
          ],
        }),
      },
    });
  }
}

const app = new App();
new SeedsBotStack(app, 'SeedsBot', {
  env: { region: 'us-east-1' },
});
