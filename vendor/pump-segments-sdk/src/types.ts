import { SegmentId } from "./segments/definitions";

export interface SegmentClientConfig {
  tableName: string;
  region?: string;
  endpoint?: string;
}

export interface SegmentMetadata {
  segmentId: SegmentId;
  versionId: string;
  memberCount: number;
  updatedAt: number;
  status: 'ready' | 'updating' | 'failed';
  stats?: {
    added?: number;
    removed?: number;
    durationMs: number;
    bigQueryBytes: number;
  };
  lastError?: string;
}

export interface MembershipResult {
  inSegment: boolean;
  versionId: string;
  sampleBucket?: number;
  joinedAt?: number;
}

export interface ExportResult {
  users: string[];
  nextCursor?: string;
  versionId: string;
}

export class SegmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SegmentError';
  }
}