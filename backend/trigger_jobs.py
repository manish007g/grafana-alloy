# backend/trigger_jobs.py
import os
os.environ["OTEL_SERVICE_NAME"] = "job-processor"

from celery import Celery

app = Celery("worker", broker=os.environ.get("REDIS_URL", "redis://localhost:6379/0"))

@app.task(name="app2_worker.process_email")
def process_email(user_id): pass

@app.task(name="app2_worker.generate_report")
def generate_report(report_id): pass

import time
print("Sending jobs to Celery worker...")

for i in range(10):
    app.send_task("app2_worker.process_email", kwargs={"user_id": i+1})
    print(f"Sent email job for user {i+1}")
    time.sleep(1)

for i in range(3):
    app.send_task("app2_worker.generate_report", kwargs={"report_id": f"report-{i+1}"})
    print(f"Sent report job {i+1}")
    time.sleep(2)

print("All jobs sent!")
