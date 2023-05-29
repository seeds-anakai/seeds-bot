FROM public.ecr.aws/lambda/python:3

COPY requirements.txt .

RUN yum install -y gcc && yum clean all && rm -rf /var/cache/yum && pip install --no-cache-dir -r requirements.txt -t ${LAMBDA_TASK_ROOT}

COPY app.py ${LAMBDA_TASK_ROOT}

CMD ["app.handler"]
