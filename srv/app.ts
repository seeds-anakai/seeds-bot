// AWS CDK
import {
  App,
  CfnOutput,
  Duration,
  Stack,
  StackProps,
  aws_apigateway as apigateway,
  aws_codebuild as codebuild,
  aws_dynamodb as dynamodb,
  aws_ecr_assets as ecr_assets,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_s3 as s3,
} from 'aws-cdk-lib';

// Constructs
import { Construct } from 'constructs';

/**
 * A root construct which represents a single CloudFormation stack.
 */
class SlackGptStack extends Stack {
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
    const [slackBotToken, slackSigningSecret, openaiApiKey, openaiOrganization] = [
      this.node.getContext('slackBotToken'),
      this.node.getContext('slackSigningSecret'),
      this.node.getContext('openaiApiKey'),
      this.node.getContext('openaiOrganization'),
    ];

    // Api Handler
    const apiHandler = new lambda.DockerImageFunction(this, 'ApiHandler', {
      code: lambda.DockerImageCode.fromImageAsset('src', {
        platform: ecr_assets.Platform.LINUX_ARM64,
      }),
      architecture: lambda.Architecture.ARM_64,
      timeout: Duration.minutes(15),
      memorySize: 1769, // 1 vCPU
      environment: {
        SLACK_BOT_TOKEN: slackBotToken,
        SLACK_SIGNING_SECRET: slackSigningSecret,
        OPENAI_API_KEY: openaiApiKey,
        OPENAI_ORGANIZATION: openaiOrganization,
      },
    });

    // Api
    const api = new apigateway.RestApi(this, 'Api', {
      restApiName: 'Slack GPT API',
      deployOptions: {
        stageName: 'default',
      },
    });

    // Add method to root resource.
    api.root.addMethod('POST', new apigateway.LambdaIntegration(apiHandler, {
      proxy: false,
      passthroughBehavior: apigateway.PassthroughBehavior.WHEN_NO_TEMPLATES,
      requestParameters: {
        'integration.request.header.X-Amz-Invocation-Type': "'Event'",
      },
      requestTemplates: {
        'application/json': `
          #set($allParams = $input.params())
          {
            #set($params = $allParams.get('header'))
            "headers": {
              #foreach($paramName in $params.keySet())
              "$paramName": "$util.escapeJavaScript($params.get($paramName))"
              #if($foreach.hasNext),#end
              #end
            },
            #set($params = $allParams.get('querystring'))
            "queryStringParameters": {
              #foreach($paramName in $params.keySet())
              "$paramName": "$util.escapeJavaScript($params.get($paramName))"
              #if($foreach.hasNext),#end
              #end
            },
            "requestContext": {
              "httpMethod": "$context.httpMethod"
            },
            "body": "$util.escapeJavaScript($input.body)",
            "isBase64Encoded": false
          }
        `,
      },
      integrationResponses: [
        {
          statusCode: '200',
        },
      ],
    }), {
      methodResponses: [
        {
          statusCode: '200',
        },
      ],
    });

    // Remove the default endpoint output.
    api.node.tryRemoveChild('Endpoint');

    // Api Endpoint
    new CfnOutput(this, 'ApiEndpoint', {
      value: api.url.replace(/\/$/, ''),
    });

    // Session Table
    const sessionTable = new dynamodb.Table(this, 'SessionTable', {
      partitionKey: {
        name: 'SessionId',
        type: dynamodb.AttributeType.STRING,
      },
    });

    // Add environment variable for access Session Table.
    apiHandler.addEnvironment('SESSION_TABLE_NAME', sessionTable.tableName);

    // Add permissions to access Session Table.
    sessionTable.grantReadWriteData(apiHandler);

    // Vector Store
    const vectorStore = new s3.Bucket(this, 'VectorStore', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    // Add environment variable for access Vector Store.
    apiHandler.addEnvironment('VECTOR_STORE_BUCKET_NAME', vectorStore.bucketName);

    // Add permissions to access Vector Store.
    vectorStore.grantReadWrite(apiHandler);

    // App Build Project
    const appBuildProject = new codebuild.Project(this, 'AppBuildProject', {
      environment: {
        buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2_STANDARD_3_0,
        privileged: true,
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            'runtime-versions': {
              nodejs: 'latest',
            },
            commands: [
              'npm install -g yarn',
            ],
          },
          pre_build: {
            commands: [
              'yarn --frozen-lockfile',
            ],
          },
          build: {
            commands: [
              'yarn cdk deploy -c slackBotToken=${SLACK_BOT_TOKEN} -c slackSigningSecret=${SLACK_SIGNING_SECRET} -c openaiApiKey=${OPENAI_API_KEY} -c openaiOrganization=${OPENAI_ORGANIZATION} --require-approval never',
            ],
          },
        },
      }),
    });

    // Add administrator access policy.
    appBuildProject.role?.addManagedPolicy?.(iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess'));
  }
}

const app = new App();
new SlackGptStack(app, 'SlackGpt', {
  env: { region: 'ap-northeast-1' },
});
