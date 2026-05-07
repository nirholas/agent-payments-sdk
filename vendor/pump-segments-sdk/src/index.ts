import { SegmentClient } from './client';
import { Segment } from './segment';
import { SegmentId } from './segments/definitions';

export { SegmentClient } from './client';
export { Segment } from './segment';
export { SegmentError } from './types';
export {
  computeSampleBucket,
  isInSample,
  formatDuration,
  formatBytes,
} from './utils';

export type {
  SegmentClientConfig,
  SegmentMetadata,
  MembershipResult,
  ExportResult,
} from './types';

/**
 * Create a segment instance
 */
export function segment(client: SegmentClient, segmentId: SegmentId): Segment {
  return new Segment(client, segmentId);
}

export { SEGMENTS, getSegmentById } from './segments/definitions';