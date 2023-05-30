import os
from typing import Any, Dict

from langchain.chains import ConversationalRetrievalChain
from langchain.chat_models import ChatOpenAI
from langchain.embeddings import OpenAIEmbeddings
from langchain.memory import ConversationBufferMemory
from langchain.memory.chat_message_histories import DynamoDBChatMessageHistory
from langchain.vectorstores import DeepLake
from slack_bolt import App
from slack_bolt.adapter.aws_lambda import SlackRequestHandler

# Slack
app = App(
    process_before_response=True,
    signing_secret=os.environ['SLACK_SIGNING_SECRET'],
    token=os.environ['SLACK_BOT_TOKEN'],
)

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
def handler(event: dict, context: dict) -> Dict[str, Any]:
    return SlackRequestHandler(app).handle(event, context)

@app.event('app_mention')
def handle_mentions(event: dict, client, say) -> None:
    # thread_ts
    thread_ts = event.get('thread_ts', event['ts'])

    # History
    history = DynamoDBChatMessageHistory(os.environ['SESSION_TABLE_NAME'], thread_ts)

    # Memory
    memory = ConversationBufferMemory(memory_key='chat_history', chat_memory=history)

    # Chain
    qa = ConversationalRetrievalChain.from_llm(
        llm=llm,
        retriever=db.as_retriever(),
        memory=memory,
        get_chat_history=lambda h: h,
    )

    # Say
    say(qa({'question': event['text']})['answer'], thread_ts=thread_ts)
