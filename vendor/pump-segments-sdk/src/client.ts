import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';
import type {
  SegmentClientConfig,
  SegmentMetadata,
  MembershipResult,
  ExportResult,
} from './types';
import { SegmentError } from './types';
import { SegmentId } from './segments/definitions';


export class SegmentClient {
  private ddb: DynamoDBDocumentClient;
  private tableName: string;

  constructor(config: SegmentClientConfig) {
    const client = new DynamoDBClient({
      region: config.region || process.env.AWS_REGION || 'us-east-1',
      ...(config.endpoint && { endpoint: config.endpoint }),
    });

    this.ddb = DynamoDBDocumentClient.from(client);
    this.tableName = config.tableName;
  }

  /**
   * Check if a user is in a segment
   */
  async isMember(segmentId: SegmentId, userId: string): Promise<boolean> {
    const result = await this.getMembership(segmentId, userId);
    return result.inSegment;
  }

  /**
   * Get detailed membership information
   */
  async getMembership(
    segmentId: SegmentId,
    userId: string
  ): Promise<MembershipResult> {
    try {
      // First, get current version from metadata
      const meta = await this.getMetadata(segmentId);
      const versionId = meta.versionId;

      // Check if user exists in this version
      const result = await this.ddb.send(
        new GetCommand({
          TableName: this.tableName,
          Key: {
            PK: `SEGMENT#${segmentId}#V#${versionId}`,
            SK: `USER#${userId}`,
          },
        })
      );

      if (!result.Item) {
        return {
          inSegment: false,
          versionId,
        };
      }

      return {
        inSegment: true,
        versionId,
        sampleBucket: result.Item.sampleBucket,
        joinedAt: result.Item.joinedAt,
      };
    } catch (error) {
      throw new SegmentError(
        `Failed to check membership: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get segment metadata
   */
  async getMetadata(segmentId: SegmentId): Promise<SegmentMetadata> {
    try {
      const result = await this.ddb.send(
        new GetCommand({
          TableName: this.tableName,
          Key: {
            PK: `SEGMENT#${segmentId}#META`,
            SK: 'METADATA',
          },
        })
      );

      if (!result.Item) {
        throw new SegmentError(`Segment not found: ${segmentId}`);
      }

      return {
        segmentId,
        versionId: result.Item.currentVersionId || '0',
        memberCount: result.Item.memberCount || 0,
        updatedAt: result.Item.lastUpdatedAt || 0,
        status: result.Item.status || 'ready',
        stats: result.Item.stats,
        lastError: result.Item.lastError,
      };
    } catch (error) {
      if (error instanceof SegmentError) throw error;
      throw new SegmentError(
        `Failed to get metadata: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Export users from a segment (paginated)
   */
  async exportUsers(
    segmentId: SegmentId,
    options?: {
      cursor?: string;
      limit?: number;
      sample?: number; // 0-1 (e.g., 0.1 = 10%)
      versionId?: string;
    }
  ): Promise<ExportResult> {
    try {
      // Get version (either specified or current)
      const versionId = options?.versionId || (await this.getMetadata(segmentId)).versionId;
      const limit = options?.limit || 1000;

      // Parse cursor if provided
      const exclusiveStartKey = options?.cursor
        ? JSON.parse(Buffer.from(options.cursor, 'base64').toString('utf-8'))
        : undefined;

      // Query all users in this version
      const queryParams: QueryCommandInput = {
        TableName: this.tableName,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: {
          ':pk': `SEGMENT#${segmentId}#V#${versionId}`,
        },
        Limit: limit,
        ExclusiveStartKey: exclusiveStartKey,
      };

      const result = await this.ddb.send(new QueryCommand(queryParams));

      let users = (result.Items || []).map((item) => {
        // Extract userId from SK: "USER#<userId>"
        return item.SK.replace('USER#', '');
      });

      // Apply sampling filter if requested
      if (options?.sample !== undefined) {
        const threshold = Math.floor(options.sample * 10000);
        users = users.filter((_, idx) => {
          const item = result.Items![idx];
          return item.sampleBucket < threshold;
        });
      }

      // Encode next cursor
      const nextCursor = result.LastEvaluatedKey
        ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64')
        : undefined;

      return {
        users,
        nextCursor,
        versionId,
      };
    } catch (error) {
      throw new SegmentError(
        `Failed to export users: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Stream all users from a segment
   */
  async *streamUsers(
    segmentId: SegmentId,
    batchSize: number = 1000
  ): AsyncIterableIterator<string[]> {
    let cursor: string | undefined;

    do {
      const result = await this.exportUsers(segmentId, {
        cursor,
        limit: batchSize,
      });

      if (result.users.length > 0) {
        yield result.users;
      }

      cursor = result.nextCursor;
    } while (cursor);
  }
}
