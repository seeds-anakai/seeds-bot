import os
from typing import Any, Dict

from langchain.chains import RetrievalQA
from langchain.chat_models import ChatOpenAI
from langchain.embeddings import OpenAIEmbeddings
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

# QA Chain
qa = RetrievalQA.from_chain_type(llm=llm, chain_type='stuff', retriever=db.as_retriever())

# Lambda Handler
def handler(event: dict, context: dict) -> Dict[str, Any]:
    return SlackRequestHandler(app).handle(event, context)

@app.event('app_mention')
def handle_mentions(event: dict, client, say) -> None:
    thread_ts = event.get('thread_ts', event['ts'])
    say(qa.run(event['text']), thread_ts=thread_ts)
