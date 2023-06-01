import os
import re
from typing import Any, Dict

from langchain.chains import ConversationalRetrievalChain
from langchain.chat_models import ChatOpenAI
from langchain.embeddings import OpenAIEmbeddings
from langchain.memory import ConversationBufferMemory
from langchain.memory.chat_message_histories import DynamoDBChatMessageHistory
from langchain.vectorstores import DeepLake
from slack_bolt import App
from slack_bolt.adapter.aws_lambda import SlackRequestHandler
from slack_bolt.context.say.say import Say
from slack_sdk.web.client import WebClient

# Slack App
app = App(
    process_before_response=True,
    signing_secret=os.environ['SLACK_SIGNING_SECRET'],
    token=os.environ['SLACK_BOT_TOKEN'],
)

# Slack Request Handler
slack_request_handler = SlackRequestHandler(app)

# LLM
llm = ChatOpenAI(temperature=0, max_tokens=1024)

# Vector Store
db = DeepLake(
    dataset_path='s3://{}/deeplake'.format(os.environ['VECTOR_STORE_BUCKET_NAME']),
    embedding_function=OpenAIEmbeddings(),
    read_only=True,
    verbose=False,
)

# Lambda Handler
def handler(event: Any, context: Any) -> Dict[str, Any]:
    return slack_request_handler.handle(event, context)

# Slack App Mention Handler
@app.event('app_mention')
def handler_app_mention(event: Dict[str, Any], client: WebClient, say: Say) -> None:
    answer(
        channel=event['channel'],
        text=event['text'],
        ts=event['ts'],
        thread_ts=event.get('thread_ts', event['ts']),
        client=client,
        say=say,
    )

# Slack Message Handler
@app.event('message')
def handler_message(event: Dict[str, Any], client: WebClient, say: Say) -> None:
    answer(
        channel=event['channel'],
        text=event['text'],
        ts=event['ts'],
        thread_ts=event.get('thread_ts', event['ts']),
        client=client,
        say=say,
    )

# Answer
def answer(channel: str, text: str, ts: str, thread_ts: str, client: WebClient, say: Say) -> None:
    # Add emoji of thinking face.
    client.reactions_add(
        channel=channel,
        name='thinking_face',
        timestamp=ts,
    )

    # History
    history = DynamoDBChatMessageHistory(os.environ['SESSION_TABLE_NAME'], thread_ts)

    # Memory
    memory = ConversationBufferMemory(memory_key='chat_history', chat_memory=history)

    # Chain
    chain = ConversationalRetrievalChain.from_llm(
        llm=llm,
        retriever=db.as_retriever(),
        memory=memory,
        get_chat_history=lambda h: h,
    )

    # Question
    question = re.sub('<@[0-9A-Z]{11}>\s*', '', text)

    # Generate answer.
    answer = chain({'question': question})['answer']

    # Say answer in thread.
    say(answer, thread_ts=thread_ts)

    # Remove emoji of thinking face.
    client.reactions_remove(
        channel=channel,
        name='thinking_face',
        timestamp=ts,
    )
