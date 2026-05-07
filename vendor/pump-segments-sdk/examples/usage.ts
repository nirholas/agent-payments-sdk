import { SegmentClient, segment } from '../src';

async function main() {
  // Initialize client (reads from DynamoDB)
  const client = new SegmentClient({
    tableName: process.env.TABLE_SEGMENTS || 'segments',
    region: 'us-east-1',
  });

  // Get segment (matches Lambda's segmentId)
  const mobileNoNotifs = segment(client, 'mobile-users-no-notifications');

  // 1. Check membership
  console.log('\n1. Check membership:');
  const isMember = await mobileNoNotifs.contains('user_123');
  console.log(`  Is user_123 in segment? ${isMember}`);

  // 2. Get metadata
  console.log('\n2. Get metadata:');
  const meta = await mobileNoNotifs.getMetadata();
  console.log(`  Total members: ${meta.memberCount.toLocaleString()}`);
  console.log(`  Version: ${meta.versionId}`);
  console.log(`  Status: ${meta.status}`);
  console.log(`  Last updated: ${new Date(meta.updatedAt).toISOString()}`);

  // 3. Get all users (first page)
  console.log('\n3. Get all users (first 100):');
  const all = await mobileNoNotifs.getAll({ limit: 100 });
  console.log(`  Retrieved: ${all.users.length} users`);
  console.log(`  Has more: ${!!all.nextCursor}`);

  // 4. Get 10% sample (uses sampleBucket from DynamoDB)
  console.log('\n4. Get 10% sample:');
  const sample = await mobileNoNotifs.getSample(0.1);
  console.log(`  Sample size: ${sample.users.length} users`);

  // 5. Stream all users
  console.log('\n5. Stream all users:');
  let total = 0;
  for await (const batch of mobileNoNotifs.stream(500)) {
    total += batch.length;
    console.log(`  Processed batch: ${batch.length} users (total: ${total})`);
    
    // Stop after 2 batches for demo
    if (total >= 1000) break;
  }
}

main().catch(console.error);