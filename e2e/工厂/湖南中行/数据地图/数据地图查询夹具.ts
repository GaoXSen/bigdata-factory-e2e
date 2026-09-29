/**
 * 表查询专用的可长期保留夹具。
 * DM-00-01 负责首次创建和上线；DM-01-04 可独立重跑并复用同一张表。
 */
export const QUERY_FIXTURE = {
  tableName: 'e2e_dm_query_fixture_v2',
  chineseName: 'E2E数据地图查询基准表V2',
  description: 'E2E数据地图表名中文名描述负责人查询专用V2',
  owner: 'admin',
  dataLevel: '应用数据层',
  databaseLevel: 'ADS',
  // 资产查询页面实际提供的“表类型”选项为 TABLE / VIEW；该建表夹具对应 TABLE。
  tableType: 'TABLE',
} as const;
