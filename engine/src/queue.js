import { Queue, Worker } from 'bullmq';

/**
 * BullMQ adapter. Jobs carry only ids/inputs (no secrets). A deterministic jobId makes enqueueing
 * idempotent, and because the engine persists state after every step, a re-delivered job after a
 * worker crash just resumes the execution.
 */
export class ExecutionQueue {
  constructor(connection, name = 'cloudforge-executions') {
    this.name = name; this.connection = connection;
    this.queue = new Queue(name, { connection, defaultJobOptions: { removeOnComplete: 1000, removeOnFail: 5000 } });
  }
  enqueueStart(orgId, workflowRef, input, { eventId, actor } = {}) {
    const jobId = eventId ? `start_${orgId}_${workflowRef}_${eventId}`.replace(/:/g, '-') : undefined;
    return this.queue.add('start', { orgId, workflowRef, input, eventId, actor }, { jobId });
  }
  enqueueResume(orgId, execId) {
    return this.queue.add('resume', { orgId, execId }); // no jobId: every resume request must run
  }
  startWorker(engine, { concurrency = 4 } = {}) {
    this.worker = new Worker(this.name, async (job) => {
      const { orgId } = job.data;
      const ex = job.name === 'start'
        ? await engine.start(orgId, job.data.workflowRef, job.data.input, { eventId: job.data.eventId, actor: job.data.actor })
        : await engine.resume(orgId, job.data.execId);
      return { execId: ex.id, status: ex.status };
    }, { connection: this.connection, concurrency });
    return this.worker;
  }
  async close() { await this.worker?.close(); await this.queue.close(); }
}
