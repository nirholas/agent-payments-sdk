import type { SegmentMetadata, ExportResult } from './types';
import { SegmentClient } from './client';
import { SegmentId } from './segments/definitions';

export class Segment {
  constructor(
    private client: SegmentClient,
    public readonly id: SegmentId
  ) {}

  /**
   * Check if a user is in this segment
   */
  async contains(userId: string): Promise<boolean> {
    return this.client.isMember(this.id, userId);
  }

  /**
   * Get all users in this segment (paginated)
   */
  async getAll(options?: {
    cursor?: string;
    limit?: number;
  }): Promise<ExportResult> {
    return this.client.exportUsers(this.id, options);
  }

  /**
   * Get a sample of users from this segment
   */
  async getSample(
    percentage: number,
    options?: { cursor?: string; limit?: number }
  ): Promise<ExportResult> {
    if (percentage <= 0 || percentage > 1) {
      throw new Error('Sample percentage must be between 0 and 1');
    }

    return this.client.exportUsers(this.id, {
      ...options,
      sample: percentage,
    });
  }

  /**
   * Stream all users in batches
   */
  async *stream(batchSize: number = 1000): AsyncIterableIterator<string[]> {
    yield* this.client.streamUsers(this.id, batchSize);
  }

  /**
   * Get segment metadata
   */
  async getMetadata(): Promise<SegmentMetadata> {
    return this.client.getMetadata(this.id);
  }

  /**
   * Get member count
   */
  async count(): Promise<number> {
    const meta = await this.getMetadata();
    return meta.memberCount;
  }
}