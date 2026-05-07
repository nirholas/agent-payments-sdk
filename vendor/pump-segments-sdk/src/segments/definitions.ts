// segments.ts
export interface SegmentDefinition<T extends string = string> {
  id: T;
  name: string;
  sql: string;
  scheduleMinutes: number;
  maxRows?: number;
  description?: string;
}

const SEGMENTS_CONFIG = [
  {
    id: "mobile-users-no-notifications",
    name: "Mobile Users Without Notifications",
    scheduleMinutes: 1440,
    sql: `
      WITH notif_data AS (
        SELECT 
          user_id,
          SUM(notifications_received) AS notifications
        FROM \`pump-data-production.analytics.daily_user_activity\`  
        WHERE metrics_date < CURRENT_DATE()
          AND metrics_date >= CURRENT_DATE() - 8
          AND was_on_mobile
          AND user_id NOT LIKE 'anon_%'
          AND user_id IS NOT NULL
        GROUP BY 1
      )
      SELECT user_id
      FROM notif_data
      WHERE notifications = 0
    `,
  },
  {
    id: "mobile-high-volume-traders",
    name: "Mobile High Volume Traders ($1k+ Weekly)",
    scheduleMinutes: 1440,
    sql: `
      WITH trading_data AS (
        SELECT 
          user_id,
          SUM(usd_volume) AS total_volume
        FROM \`pump-data-production.analytics.daily_user_activity\`  
        WHERE metrics_date < CURRENT_DATE()
          AND metrics_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY)
          AND user_id NOT LIKE 'anon_%'
          AND user_id IS NOT NULL
          AND was_on_mobile = TRUE
        GROUP BY 1
      )
      SELECT user_id
      FROM trading_data
      WHERE total_volume >= 1000
    `,
  },
  {
    id: "mobile-active-yesterday",
    name: "Mobile Users Active Yesterday",
    scheduleMinutes: 1440,
    sql: `
      SELECT DISTINCT user_id
      FROM \`pump-data-production.analytics.daily_user_activity\`  
      WHERE metrics_date = DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
        AND user_id NOT LIKE 'anon_%'
        AND user_id IS NOT NULL
        AND was_on_mobile = TRUE
    `,
  },
] as const satisfies readonly SegmentDefinition[];

export type SegmentId = (typeof SEGMENTS_CONFIG)[number]["id"];

export const SEGMENTS: SegmentDefinition<SegmentId>[] = [...SEGMENTS_CONFIG];

export const getSegmentById = <T extends SegmentId>(
  id: T
): SegmentDefinition<T> | undefined =>
  SEGMENTS.find((s): s is SegmentDefinition<T> => s.id === id);
