import { RedisClient } from './classes';
import { Cluster } from 'ioredis';

export const errorObject: { [index: string]: any } = { value: null };

export function tryCatch(fn: (...args: any) => any, ctx: any, args: any[]) {
  try {
    return fn.apply(ctx, args);
  } catch (e) {
    errorObject.value = e;
    return errorObject;
  }
}

/**
 * Checks the size of string for ascii/non-ascii characters
 * (Reference: https://stackoverflow.com/a/23318053/1347170)
 * @param {string} str
 */
export function lengthInUtf8Bytes(str: string): number {
  return Buffer.byteLength(str, 'utf8');
}

export function isEmpty(obj: object): boolean {
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      return false;
    }
  }
  return true;
}

export function array2obj(arr: string[]) {
  const obj: { [index: string]: string } = {};
  for (let i = 0; i < arr.length; i += 2) {
    obj[arr[i]] = arr[i + 1];
  }
  return obj;
}

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(() => resolve(), ms);
  });
}

export function isRedisInstance(obj: any): boolean {
  if (!obj) {
    return false;
  }
  const redisApi = ['connect', 'disconnect', 'duplicate'];
  return redisApi.every(name => typeof obj[name] === 'function');
}

export async function removeAllQueueData(
  client: RedisClient,
  queueName: string,
  prefix = 'bull',
) {
  if (client instanceof Cluster) {
    // todo compat with cluster ?
    // @see https://github.com/luin/ioredis/issues/175
    return Promise.resolve(false);
  }
  const pattern = `${prefix}:${queueName}:*`;
  return new Promise<void>((resolve, reject) => {
    const stream = client.scanStream({
      match: pattern,
    });
    stream.on('data', (keys: string[]) => {
      if (keys.length) {
        const pipeline = client.pipeline();
        keys.forEach(key => {
          pipeline.del(key);
        });
        pipeline.exec().catch(error => {
          reject(error);
        });
      }
    });
    stream.on('end', () => resolve());
    stream.on('error', error => reject(error));
  });
}

export function getParentKey(opts: { id: string; queue: string }): string {
  if (opts) {
    return `${opts.queue}:${opts.id}`;
  }
}

export const clientCommandMessageReg = /ERR unknown command ['`]\s*client\s*['`]/;
