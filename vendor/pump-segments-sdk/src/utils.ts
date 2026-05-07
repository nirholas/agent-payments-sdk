import murmur from 'imurmurhash';

/**
 * Compute sample bucket (same algorithm as Lambda)
 */
export function computeSampleBucket(
  userId: string,
  segmentId: string,
  salt: string
): number {
  const hash = murmur(`${userId}#${segmentId}#${salt}`).result() >>> 0;
  return hash % 10000;
}

/**
 * Check if a bucket is in sample
 */
export function isInSample(bucket: number, percentage: number): boolean {
  if (percentage <= 0 || percentage > 1) {
    throw new Error('Percentage must be between 0 and 1');
  }
  return bucket < Math.floor(percentage * 10000);
}

/**
 * Format duration in human-readable format
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${(ms / 60000).toFixed(1)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
}

/**
 * Format byte size in human-readable format
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}
