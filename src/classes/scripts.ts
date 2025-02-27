/**
 * Includes all the scripts needed by the queue and jobs.
 */

/*eslint-env node */
'use strict';

import * as semver from 'semver';
import {
  JobsOptions,
  QueueSchedulerOptions,
  WorkerOptions,
} from '../interfaces';
import { array2obj, getParentKey } from '../utils';
import { Worker } from './worker';
import { QueueScheduler } from './queue-scheduler';
import { QueueBase } from './queue-base';
import { Job, JobJson, JobJsonRaw, MoveToChildrenOpts } from './job';
import { RedisClient } from './redis-connection';

export type MinimalQueue = Pick<
  QueueBase,
  | 'name'
  | 'client'
  | 'toKey'
  | 'keys'
  | 'opts'
  | 'closing'
  | 'waitUntilReady'
  | 'removeListener'
  | 'emit'
  | 'on'
  | 'redisVersion'
>;

export type ParentOpts = {
  waitChildrenKey?: string;
  parentDependenciesKey?: string;
  parentKey?: string;
};

export class Scripts {
  static async isJobInList(
    queue: MinimalQueue,
    listKey: string,
    jobId: string,
  ) {
    const client = await queue.client;
    let result;
    if (semver.lt(queue.redisVersion, '6.0.6')) {
      result = await (<any>client).isJobInList([listKey, jobId]);
    } else {
      result = await (<any>client).lpos(listKey, jobId);
    }
    return Number.isInteger(result);
  }

  static addJob(
    client: RedisClient,
    queue: MinimalQueue,
    job: JobJson,
    opts: JobsOptions,
    jobId: string,
    parentOpts: ParentOpts = {
      waitChildrenKey: null,
      parentDependenciesKey: null,
      parentKey: null,
    },
  ) {
    const queueKeys = queue.keys;
    let keys = [
      queueKeys.wait,
      queueKeys.paused,
      queueKeys.meta,
      queueKeys.id,
      queueKeys.delayed,
      queueKeys.priority,
      queueKeys.events,
      queueKeys.delay,
    ];

    const args = [
      queueKeys[''],
      typeof jobId !== 'undefined' ? jobId : '',
      job.name,
      job.data,
      job.opts,
      job.timestamp,
      opts.delay,
      opts.delay ? job.timestamp + opts.delay : 0,
      opts.priority || 0,
      opts.lifo ? 'RPUSH' : 'LPUSH',
      parentOpts.parentKey,
      parentOpts.waitChildrenKey,
      parentOpts.parentDependenciesKey,
    ];

    keys = keys.concat(<string[]>args);

    return (<any>client).addJob(keys);
  }

  static async pause(queue: MinimalQueue, pause: boolean) {
    const client = await queue.client;

    let src = 'wait',
      dst = 'paused';
    if (!pause) {
      src = 'paused';
      dst = 'wait';
    }

    const keys = [src, dst, 'meta'].map((name: string) => queue.toKey(name));

    keys.push(queue.keys.events);

    return (<any>client).pause(keys.concat([pause ? 'paused' : 'resumed']));
  }

  static async remove(queue: MinimalQueue, jobId: string) {
    const client = await queue.client;

    const keys = [jobId].map(name => queue.toKey(name));
    return (<any>client).removeJob(keys.concat([jobId]));
  }

  static async extendLock(
    queue: MinimalQueue,
    jobId: string,
    token: string,
    duration: number,
  ) {
    const client = await queue.client;
    const args = [
      queue.toKey(jobId) + ':lock',
      queue.keys.stalled,
      token,
      duration,
      jobId,
    ];
    return (<any>client).extendLock(args);
  }

  static async updateProgress(
    queue: MinimalQueue,
    job: Job,
    progress: number | object,
  ) {
    const client = await queue.client;

    const keys = [queue.toKey(job.id), queue.keys.events];
    const progressJson = JSON.stringify(progress);

    await (<any>client).updateProgress(keys, [job.id, progressJson]);
    queue.emit('progress', job, progress);
  }

  static moveToFinishedArgs(
    queue: MinimalQueue,
    job: Job,
    val: any,
    propVal: string,
    shouldRemove: boolean | number,
    target: string,
    token: string,
    fetchNext = true,
  ) {
    const queueKeys = queue.keys;
    const opts: WorkerOptions = <WorkerOptions>queue.opts;

    const keys = [
      queueKeys.active,
      queueKeys[target],
      queue.toKey(job.id),
      queueKeys.wait,
      queueKeys.priority,
      queueKeys.events,
      queueKeys.meta,
      queueKeys.stalled,
    ];

    let remove;
    if (typeof shouldRemove === 'boolean') {
      remove = shouldRemove ? '1' : '0';
    } else if (typeof shouldRemove === 'number') {
      remove = `${shouldRemove + 1}`;
    }

    const args = [
      job.id,
      Date.now(),
      propVal,
      typeof val === 'undefined' ? 'null' : val,
      target,
      remove,
      JSON.stringify({ jobId: job.id, val: val }),
      !fetchNext || queue.closing || opts.limiter ? 0 : 1,
      queueKeys[''],
      token,
      opts.lockDuration,
      job.opts?.parent?.id,
      job.opts?.parent?.queue,
    ];

    return keys.concat(args);
  }

  static async moveToFinished(
    queue: MinimalQueue,
    job: Job,
    val: any,
    propVal: string,
    shouldRemove: boolean | number,
    target: string,
    token: string,
    fetchNext: boolean,
  ) {
    const client = await queue.client;
    const args = this.moveToFinishedArgs(
      queue,
      job,
      val,
      propVal,
      shouldRemove,
      target,
      token,
      fetchNext,
    );

    const result = await (<any>client).moveToFinished(args);
    if (result < 0) {
      throw this.finishedErrors(result, job.id, 'finished', 'active');
    } else if (result) {
      return raw2jobData(result);
    }
  }

  static finishedErrors(
    code: number,
    jobId: string,
    command: string,
    state: string,
  ): Error {
    switch (code) {
      case -1:
        return new Error(`Missing key for job ${jobId}. ${command}`);
      case -2:
        return new Error(`Missing lock for job ${jobId}. ${command}`);
      case -3:
        return new Error(
          `Job ${jobId} is not in the ${state} state. ${command}`,
        );
      case -4:
        return new Error(`Job ${jobId} has pending dependencies. ${command}`);
    }
  }

  static moveToCompleted(
    queue: MinimalQueue,
    job: Job,
    returnvalue: any,
    removeOnComplete: boolean | number,
    token: string,
    fetchNext: boolean,
  ) {
    return this.moveToFinished(
      queue,
      job,
      returnvalue,
      'returnvalue',
      removeOnComplete,
      'completed',
      token,
      fetchNext,
    );
  }

  static moveToFailedArgs(
    queue: MinimalQueue,
    job: Job,
    failedReason: string,
    removeOnFailed: boolean | number,
    token: string,
    fetchNext = false,
  ) {
    return this.moveToFinishedArgs(
      queue,
      job,
      failedReason,
      'failedReason',
      removeOnFailed,
      'failed',
      token,
      fetchNext,
    );
  }

  static async isFinished(queue: MinimalQueue, jobId: string) {
    const client = await queue.client;

    const keys = ['completed', 'failed'].map(function(key: string) {
      return queue.toKey(key);
    });

    return (<any>client).isFinished(keys.concat([jobId]));
  }

  static async getState(queue: MinimalQueue, jobId: string) {
    const client = await queue.client;

    const keys = [
      'completed',
      'failed',
      'delayed',
      'active',
      'wait',
      'paused',
      'waiting-children',
    ].map(function(key: string) {
      return queue.toKey(key);
    });

    if (semver.lt(queue.redisVersion, '6.0.6')) {
      return (<any>client).getState(keys.concat([jobId]));
    }
    return (<any>client).getStateV2(keys.concat([jobId]));
  }

  static async changeDelay(
    queue: MinimalQueue,
    jobId: string,
    delay: number,
  ): Promise<void> {
    const client = await queue.client;

    const args = this.changeDelayArgs(queue, jobId, delay);
    const result = await (<any>client).changeDelay(args);
    if (result < 0) {
      throw this.finishedErrors(result, jobId, 'changeDelay', 'delayed');
    }
  }

  static changeDelayArgs(
    queue: MinimalQueue,
    jobId: string,
    timestamp: number,
  ): string[] {
    //
    // Bake in the job id first 12 bits into the timestamp
    // to guarantee correct execution order of delayed jobs
    // (up to 4096 jobs per given timestamp or 4096 jobs apart per timestamp)
    //
    // WARNING: Jobs that are so far apart that they wrap around will cause FIFO to fail
    //
    timestamp = Math.max(0, timestamp);

    if (timestamp > 0) {
      timestamp = timestamp * 0x1000 + (+jobId & 0xfff);
    }

    const keys = ['delayed', jobId].map(function(name) {
      return queue.toKey(name);
    });
    keys.push.apply(keys, [queue.keys.events, queue.keys.delay]);

    return keys.concat([JSON.stringify(timestamp), jobId]);
  }

  // Note: We have an issue here with jobs using custom job ids
  static moveToDelayedArgs(
    queue: MinimalQueue,
    jobId: string,
    timestamp: number,
  ) {
    //
    // Bake in the job id first 12 bits into the timestamp
    // to guarantee correct execution order of delayed jobs
    // (up to 4096 jobs per given timestamp or 4096 jobs apart per timestamp)
    //
    // WARNING: Jobs that are so far apart that they wrap around will cause FIFO to fail
    //
    timestamp = Math.max(0, timestamp ?? 0);

    if (timestamp > 0) {
      timestamp = timestamp * 0x1000 + (+jobId & 0xfff);
    }

    const keys = ['active', 'delayed', jobId].map(function(name) {
      return queue.toKey(name);
    });
    keys.push.apply(keys, [queue.keys.events, queue.keys.delay]);

    return keys.concat([JSON.stringify(timestamp), jobId]);
  }

  static moveToWaitingChildrenArgs(
    queue: MinimalQueue,
    jobId: string,
    token: string,
    opts?: MoveToChildrenOpts,
  ) {
    let timestamp = Math.max(0, opts.timestamp ?? 0);

    const childKey = getParentKey(opts.child);

    if (timestamp > 0) {
      timestamp = timestamp * 0x1000 + (+jobId & 0xfff);
    }

    const keys = [`${jobId}:lock`, 'active', 'waiting-children', jobId].map(
      function(name) {
        return queue.toKey(name);
      },
    );

    return keys.concat([
      token,
      childKey ?? '',
      JSON.stringify(timestamp),
      jobId,
    ]);
  }

  static async moveToDelayed(
    queue: MinimalQueue,
    jobId: string,
    timestamp: number,
  ) {
    const client = await queue.client;

    const args = this.moveToDelayedArgs(queue, jobId, timestamp);
    const result = await (<any>client).moveToDelayed(args);
    if (result < 0) {
      throw this.finishedErrors(result, jobId, 'moveToDelayed', 'active');
    }
  }

  static async moveToWaitingChildren(
    queue: MinimalQueue,
    jobId: string,
    token: string,
    opts: MoveToChildrenOpts = {},
  ) {
    const client = await queue.client;
    const multi = client.multi();

    const args = this.moveToWaitingChildrenArgs(queue, jobId, token, opts);
    (<any>multi).moveToWaitingChildren(args);
    const [[err, result]] = (await multi.exec()) as [[null | Error, number]];

    switch (result) {
      case 0:
        return true;
      case 1:
        return false;
      default:
        return this.finishedErrors(
          result,
          jobId,
          'moveToWaitingChildren',
          'active',
        );
    }
  }

  static async cleanJobsInSet(
    queue: MinimalQueue,
    set: string,
    timestamp: number,
    limit = 0,
  ) {
    const client = await queue.client;

    return (<any>client).cleanJobsInSet([
      queue.toKey(set),
      queue.toKey(''),
      timestamp,
      limit,
      set,
    ]);
  }

  static retryJobArgs(queue: MinimalQueue, job: Job) {
    const jobId = job.id;

    const keys = ['active', 'wait', jobId].map(function(name) {
      return queue.toKey(name);
    });

    keys.push(queue.keys.events);

    const pushCmd = (job.opts.lifo ? 'R' : 'L') + 'PUSH';

    return keys.concat([pushCmd, jobId]);
  }

  /**
   * Attempts to reprocess a job
   *
   * @param {Job} job
   * @param {Object} options
   * @param {String} options.state The expected job state. If the job is not found
   * on the provided state, then it's not reprocessed. Supported states: 'failed', 'completed'
   *
   * @return {Promise<Number>} Returns a promise that evaluates to a return code:
   * 1 means the operation was a success
   * 0 means the job does not exist
   * -1 means the job is currently locked and can't be retried.
   * -2 means the job was not found in the expected set
   */
  static async reprocessJob(
    queue: MinimalQueue,
    job: Job,
    state: 'failed' | 'completed',
  ) {
    const client = await queue.client;

    const keys = [
      queue.toKey(job.id),
      queue.keys.events,
      queue.toKey(state),
      queue.toKey('wait'),
    ];

    const args = [job.id, (job.opts.lifo ? 'R' : 'L') + 'PUSH'];

    return (<any>client).reprocessJob(keys.concat(args));
  }

  static async moveToActive<T, R, N extends string>(
    worker: Worker<T, R, N>,
    token: string,
    jobId?: string,
  ) {
    const client = await worker.client;
    const opts = worker.opts;

    const queueKeys = worker.keys;
    const keys = [queueKeys.wait, queueKeys.active, queueKeys.priority];

    keys[3] = queueKeys.events;
    keys[4] = queueKeys.stalled;
    keys[5] = queueKeys.limiter;
    keys[6] = queueKeys.delayed;
    keys[7] = queueKeys.delay;

    const args: (string | number | boolean)[] = [
      queueKeys[''],
      token,
      opts.lockDuration,
      Date.now(),
      jobId,
    ];

    if (opts.limiter) {
      args.push(opts.limiter.max, opts.limiter.duration);
      opts.limiter.groupKey && args.push(true);
    }

    const result = await (<any>client).moveToActive(
      (<(string | number | boolean)[]>keys).concat(args),
    );

    if (typeof result === 'number') {
      return [result, void 0] as [number, undefined];
    }
    return raw2jobData(result);
  }

  //
  //  It checks if the job in the top of the delay set should be moved back to the
  //  top of the  wait queue (so that it will be processed as soon as possible)
  //
  static async updateDelaySet(queue: MinimalQueue, delayedTimestamp: number) {
    const client = await queue.client;

    const keys: (string | number)[] = [
      queue.keys.delayed,
      queue.keys.wait,
      queue.keys.priority,
      queue.keys.paused,
      queue.keys.meta,
      queue.keys.events,
      queue.keys.delay,
    ];

    const args = [queue.toKey(''), delayedTimestamp];

    return (<any>client).updateDelaySet(keys.concat(args));
  }

  static async promote(queue: MinimalQueue, jobId: string) {
    const client = await queue.client;

    const keys = [
      queue.keys.delayed,
      queue.keys.wait,
      queue.keys.paused,
      queue.keys.priority,
      queue.keys.events,
    ];

    const args = [queue.toKey(''), jobId];

    return (<any>client).promote(keys.concat(args));
  }

  //
  // Looks for unlocked jobs in the active queue.
  //
  //    The job was being worked on, but the worker process died and it failed to renew the lock.
  //    We call these jobs 'stalled'. This is the most common case. We resolve these by moving them
  //    back to wait to be re-processed. To prevent jobs from cycling endlessly between active and wait,
  //    (e.g. if the job handler keeps crashing),
  //    we limit the number stalled job recoveries to settings.maxStalledCount.
  //
  static async moveStalledJobsToWait(queue: QueueScheduler) {
    const client = await queue.client;

    const opts = queue.opts as QueueSchedulerOptions;
    const keys: (string | number)[] = [
      queue.keys.stalled,
      queue.keys.wait,
      queue.keys.active,
      queue.keys.failed,
      queue.keys['stalled-check'],
      queue.keys.meta,
      queue.keys.paused,
      queue.keys.events,
    ];
    const args = [
      opts.maxStalledCount,
      queue.toKey(''),
      Date.now(),
      opts.stalledInterval,
    ];
    return (<any>client).moveStalledJobsToWait(keys.concat(args));
  }

  static async obliterate(
    queue: MinimalQueue,
    opts: { force: boolean; count: number },
  ) {
    const client = await queue.client;

    const keys: (string | number)[] = [queue.keys.meta, queue.toKey('')];
    const args = [opts.count, opts.force ? 'force' : null];

    const result = await (<any>client).obliterate(keys.concat(args));
    if (result < 0) {
      switch (result) {
        case -1:
          throw new Error('Cannot obliterate non-paused queue');
        case -2:
          throw new Error('Cannot obliterate queue with active jobs');
      }
    }
    return result;
  }

  /*
//   *
//    * Attempts to reprocess a job
//    *
//    * @param {Job} job
//    * @param {Object} options
//    * @param {String} options.state The expected job state. If the job is not found
//    * on the provided state, then it's not reprocessed. Supported states: 'failed', 'completed'
//    *
//    * @return {Promise<Number>} Returns a promise that evaluates to a return code:
//    * 1 means the operation was a success
//    * 0 means the job does not exist
//    * -1 means the job is currently locked and can't be retried.
//    * -2 means the job was not found in the expected set

  static reprocessJob(job: Jov, state: string) {
    var queue = job.queue;

    var keys = [
      queue.toKey(job.id),
      queue.toKey(job.id) + ':lock',
      queue.toKey(state),
      queue.toKey('wait'),
    ];

    var args = [job.id, (job.opts.lifo ? 'R' : 'L') + 'PUSH', queue.token];

    return queue.client.reprocessJob(keys.concat(args));
  }
  */
}

function raw2jobData(raw: any[]): [JobJsonRaw, string] | [] {
  if (raw) {
    const jobData = raw[0];
    if (jobData.length) {
      const job: any = array2obj(jobData);
      return [job, raw[1]];
    }
  }
  return [];
}
