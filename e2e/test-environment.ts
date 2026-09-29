/**
 * e2e/test-environment.ts — 湖南中行 E2E 环境配置中心（唯一 process.env 读取入口）
 *
 * 设计目标（ENV-CONFIG-40）：
 *   - 环境重置、数据源显示名、FTP/SFTP 地址或目录变更时，只更新一个 profile 或环境变量；
 *   - 区分三类概念：物理数据库连接 / 平台数据源显示名 / 文件传输 profile（FTP 与 SFTP 分离）；
 *   - E2E_ENV_PROFILE 默认 mysql110-ftp113；未知 profile 抛可读错误；任何单项环境变量
 *     均可覆盖 profile 默认值；
 *   - 真实凭据（数据库/FTP/SFTP/账号密码）只从进程环境变量读取，本文件不提供任何默认密码；
 *   - 校验函数按需只校验必要项，错误消息只列出缺失的变量名，不回显任何变量值。
 *
 * 兼容说明：首次解析后会把原启动脚本设置过的兼容变量（QUERY_SOURCE_NAME、FTP_HOST、
 * DATA_SYNC_* 等）按 profile 默认值回填到 process.env（仅当该变量当前未设置，且
 * DB/FTP 非凭据项以“凭据已提供或主机已显式指定”为前提），因此尚未迁移到本入口的
 * 旧用例在启动脚本去掉重复默认值后仍按原语义运行。
 */

export type E2eEnvProfile = 'mysql110-ftp113';
export type DatabaseDriverType = 'mysql' | 'postgres' | 'gauss' | 'gbase';
export type FileTransferProtocol = 'ftp' | 'sftp';

/** 物理数据库连接（仅描述连接本身，不含平台显示名语义）。 */
export interface DatabaseConnectionConfig {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  type: DatabaseDriverType;
}

/** 平台页面可见的数据源显示名（可能与物理 host 不同，允许逐模块独立覆盖）。 */
export interface DataSourceDisplayConfig {
  type: string;
  name: string;
  database: string;
  schema: string;
  table?: string;
}

/** 文件传输 profile；FTP 与 SFTP 各自独立，username/password 只来自环境变量。 */
export interface FileTransferProfileConfig {
  protocol: FileTransferProtocol;
  host: string;
  port: number;
  baseDir: string;
  baseFile: string;
  username: string;
  password: string;
}

export interface TestEnvironmentConfig {
  profile: E2eEnvProfile;
  /** 被测前端入口（湖南中行默认数据源管理页；e2e/utils.ts 旧默认为文件接入页）。 */
  app: { entryUrl: string; fileAccessEntryUrl: string };
  /** 登录账号；testPass 只能来自 TEST_PASS，无默认值。 */
  accounts: { testUser: string; testPass: string };
  databases: {
    /** 默认 MySQL 110（profile 基线：192.168.76.110:13306/e2e_test）。 */
    primary: DatabaseConnectionConfig;
    /** 113 仅作为明确的第二数据源（192.168.76.113:13306），不作为默认。 */
    secondary113: DatabaseConnectionConfig;
  };
  dataSourceNames: {
    query: DataSourceDisplayConfig;
    fileAccess: DataSourceDisplayConfig & { samplePath: string };
    fileAccessExisting: DataSourceDisplayConfig;
    dataSyncSource: DataSourceDisplayConfig;
    dataSyncTarget: DataSourceDisplayConfig;
    dataSyncVerifiedTask: string;
    exportSource: DataSourceDisplayConfig;
    apiService: DataSourceDisplayConfig;
    tableManagement: { newDataBase: string };
    gaussSourceName: string;
    gbaseSourceName: string;
  };
  fileTransfer: {
    /** 文件接入默认传输：FTP 192.168.76.113:2121，目录 /，基础文件 gs_test.csv。 */
    ftp: FileTransferProfileConfig;
    /** SFTP 独立 profile（默认 192.168.76.110:22，目录 /source）。 */
    sftp: FileTransferProfileConfig;
    /** 远端日期文件可用截止日（当前环境基线 2026-10-30）。 */
    dateFileAvailableUntil: string;
    /** 新建 FTP 任务的远端文件日期偏移；不设置时用例沿用各自页面回显策略。 */
    fileDateOffset: string | undefined;
  };
}

// ==================== profile 基线（唯一默认值来源） ====================

const SUPPORTED_PROFILES: readonly E2eEnvProfile[] = ['mysql110-ftp113'];

const PROFILE_BASELINE = {
  primaryDb: { host: '192.168.76.110', port: 13306, database: 'e2e_test' },
  secondaryDb113: { host: '192.168.76.113', port: 13306, database: 'e2e_test' },
  ftp: { host: '192.168.76.113', port: 2121, baseDir: '/gs/', baseFile: 'gs_test.csv' },
  sftp: { host: '192.168.76.110', port: 22, baseDir: '/source', baseFile: 'gs_test.csv' },
  primaryDataSourceName: '192.168.76.110:13306/e2e_test',
  dateFileAvailableUntil: '2026-10-30',
} as const;

const DEFAULT_ENTRY_URL = 'http://bigdata.dev.northking.net/bigdata-ui-factory/#/dataAccess/dataSource';
const DEFAULT_FILE_ACCESS_ENTRY_URL = 'http://bigdata.dev.northking.net/bigdata-ui-factory/#/dataAccess/fileAccess';


// ==================== 读取工具（唯一 process.env 访问点） ====================

/** 读取环境变量并修剪首尾空白（兼容 cmd 未加引号 set 注入的尾随空格）；空串视为未设置。 */
function readEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

function readString(name: string, fallback: string): string {
  return readEnv(name) ?? fallback;
}

function readPort(name: string, fallback: number): number {
  const raw = readEnv(name);
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 && value <= 65535 ? Math.trunc(value) : fallback;
}

function readDriverType(name: string, fallback: DatabaseDriverType): DatabaseDriverType {
  return readString(name, fallback) as DatabaseDriverType;
}

// ==================== 解析 ====================

function resolveProfileName(): E2eEnvProfile {
  const requested = readEnv('E2E_ENV_PROFILE') ?? SUPPORTED_PROFILES[0];
  if ((SUPPORTED_PROFILES as readonly string[]).includes(requested)) {
    return requested as E2eEnvProfile;
  }
  throw new Error(
    `未知 E2E_ENV_PROFILE "${requested}"：当前仅支持 ${SUPPORTED_PROFILES.join('、')}。` +
      '请修正 E2E_ENV_PROFILE，或清除该变量以使用默认 profile。',
  );
}

function resolveFtpProtocol(): FileTransferProtocol {
  const raw = readEnv('FTP_PROTOCOL');
  if (!raw) return 'ftp';
  const value = raw.toLowerCase();
  if (value === 'ftp' || value === 'sftp') return value;
  throw new Error(
    'FTP_PROTOCOL 仅支持 ftp/sftp（当前取值无法识别，已按安全策略拒绝继续）。' +
      '请修正 FTP_PROTOCOL 或清除该变量以使用 profile 默认 ftp。',
  );
}

function buildDatabasePrimary(): DatabaseConnectionConfig {
  const host = readString('DB_HOST', PROFILE_BASELINE.primaryDb.host);
  const isProfileHost = host === PROFILE_BASELINE.primaryDb.host;
  return {
    host,
    port: readPort('DB_PORT', isProfileHost ? PROFILE_BASELINE.primaryDb.port : 3306),
    database: readString('DB_NAME', isProfileHost ? PROFILE_BASELINE.primaryDb.database : ''),
    username: readString('DB_USER', ''),
    password: readString('DB_PASS', ''),
    type: readDriverType('DB_TYPE', 'mysql'),
  };
}

function buildDatabaseSecondary113(): DatabaseConnectionConfig {
  return {
    host: readString('DB113_HOST', PROFILE_BASELINE.secondaryDb113.host),
    port: readPort('DB113_PORT', PROFILE_BASELINE.secondaryDb113.port),
    database: readString('DB113_DATABASE', PROFILE_BASELINE.secondaryDb113.database),
    username: readString('DB113_USER', readString('DB_USER', '')),
    password: readString('DB113_PASS', readString('DB_PASS', '')),
    type: readDriverType('DB113_TYPE', 'mysql'),
  };
}

function buildConfig(): TestEnvironmentConfig {
  const profile = resolveProfileName();
  const displayName = PROFILE_BASELINE.primaryDataSourceName;
  return {
    profile,
    app: {
      entryUrl: readString('ENTRY_URL', DEFAULT_ENTRY_URL),
      fileAccessEntryUrl: readString('ENTRY_URL', DEFAULT_FILE_ACCESS_ENTRY_URL),
    },
    accounts: {
      testUser: readString('TEST_USER', 'admin'),
      testPass: readString('TEST_PASS', ''),
    },
    databases: {
      primary: buildDatabasePrimary(),
      secondary113: buildDatabaseSecondary113(),
    },
    dataSourceNames: {
      query: {
        type: readString('QUERY_SOURCE_TYPE', 'MYSQL'),
        name: readString('QUERY_SOURCE_NAME', displayName),
        database: readString('QUERY_SCHEMA', 'e2e_test'),
        schema: readString('QUERY_SCHEMA', 'e2e_test'),
      },
      fileAccess: {
        type: readString('FILE_AUTO_SOURCE_TYPE', 'MYSQL'),
        name: readString('FILE_AUTO_SOURCE_NAME', displayName),
        database: readString('FILE_AUTO_DATABASE', 'e2e_test'),
        schema: readString('FILE_AUTO_SCHEMA', 'e2e_test'),
        samplePath: readString(
          'FILE_ACCESS_SAMPLE_PATH',
          'e2e/工厂/湖南中行/资源/文件接入/gs_test_data.csv',
        ),
      },
      fileAccessExisting: {
        type: readString('FILE_EXISTING_SOURCE_TYPE', 'MYSQL'),
        name: readString('FILE_EXISTING_SOURCE_NAME', displayName),
        database: readString('FILE_EXISTING_DATABASE', 'e2e_test'),
        schema: readString('FILE_EXISTING_SCHEMA', 'e2e_test'),
        table: readString('FILE_EXISTING_TABLE', 't_file_auto_fcc05ba8'),
      },
      dataSyncSource: {
        type: readString('DATA_SYNC_SOURCE_TYPE', 'MYSQL'),
        name: readString('DATA_SYNC_SOURCE_NAME', displayName),
        database: readString('DATA_SYNC_SOURCE_DATABASE', 'e2e_test'),
        schema: readString('DATA_SYNC_SOURCE_SCHEMA', 'e2e_test'),
        table: readString('DATA_SYNC_SOURCE_TABLE', 'test_gs_0903'),
      },
      dataSyncTarget: {
        type: readString('DATA_SYNC_TARGET_TYPE', 'MYSQL'),
        name: readString('DATA_SYNC_TARGET_NAME', displayName),
        database: readString('DATA_SYNC_TARGET_DATABASE', 'e2e_test_tables'),
        schema: readString('DATA_SYNC_TARGET_SCHEMA', 'e2e_test_tables'),
      },
      dataSyncVerifiedTask: readString('DATA_SYNC_VERIFIED_TASK', 'test_gs_0903'),
      exportSource: {
        type: readString('EXPORT_SOURCE_TYPE', 'MYSQL'),
        name: readString('EXPORT_SOURCE_NAME', displayName),
        database: readString('EXPORT_DATABASE', 'e2e_test'),
        schema: readString('EXPORT_SCHEMA', 'e2e_test'),
        table: readString('EXPORT_SOURCE_TABLE', 'e2e_hn_lineage_source_0920'),
      },
      apiService: {
        type: readString('API_DATA_SOURCE_TYPE', 'MYSQL'),
        name: readString('API_DATA_SOURCE_NAME', displayName),
        database: readString('API_DATABASE', 'e2e_test'),
        schema: readString('API_SCHEMA', 'e2e_test'),
        table: readString('API_TABLE', 'e2e_hn_lineage_source_0920'),
      },
      tableManagement: {
        newDataBase: readString('TABLE_NEW_DATABASE', '192.168.76.110:13306'),
      },
      gaussSourceName: readString('GAUSS_SOURCE_NAME', 'HN_E2E_GAUSS_192.168.79.52'),
      gbaseSourceName: readString('GBASE_SOURCE_NAME', 'HN_E2E_GBASE_192.168.79.69'),
    },
    fileTransfer: {
      ftp: {
        protocol: resolveFtpProtocol(),
        host: readString('FTP_HOST', PROFILE_BASELINE.ftp.host),
        port: readPort('FTP_PORT', PROFILE_BASELINE.ftp.port),
        baseDir: readString('FTP_FILE_PATH', PROFILE_BASELINE.ftp.baseDir),
        baseFile: readString('FTP_BASE_FILE', PROFILE_BASELINE.ftp.baseFile),
        username: readString('FTP_USER', ''),
        password: readString('FTP_PASS', ''),
      },
      sftp: {
        protocol: 'sftp',
        host: readString('SFTP_HOST', PROFILE_BASELINE.sftp.host),
        port: readPort('SFTP_PORT', PROFILE_BASELINE.sftp.port),
        baseDir: readString('SFTP_PATH', PROFILE_BASELINE.sftp.baseDir),
        baseFile: readString('SFTP_BASE_FILE', PROFILE_BASELINE.sftp.baseFile),
        username: readString('SFTP_USER', ''),
        password: readString('SFTP_PASS', ''),
      },
      dateFileAvailableUntil: PROFILE_BASELINE.dateFileAvailableUntil,
      fileDateOffset: readEnv('FTP_FILE_DATE_OFFSET'),
    },
  };
}

// ==================== 兼容回填（保持既有变量名与用例语义不失效） ====================

function backfillEnv(name: string, value: string | undefined): void {
  if (!value) return;
  const current = process.env[name];
  if (current === undefined || current.trim() === '') {
    process.env[name] = value;
  }
}

/**
 * 把 profile 默认值回填为旧变量名（仅当未设置时）。
 *
 * 回填集合 = 原启动脚本曾经设置的全部非凭据默认值；凭据（DB_USER/DB_PASS、
 * FTP_USER/FTP_PASS、SFTP_*）永不回填。DB/FTP 非凭据项仅在“凭据已提供或
 * 主机已显式指定”时回填，保持旧用例“未配置即跳过”的语义不变。
 */
function applyLegacyEnvBackfill(config: TestEnvironmentConfig): void {
  const db = config.databases.primary;
  const dbReady =
    readEnv('DB_HOST') !== undefined ||
    (readEnv('DB_USER') !== undefined && readEnv('DB_PASS') !== undefined);
  if (dbReady) {
    backfillEnv('DB_HOST', db.host);
    backfillEnv('DB_PORT', String(db.port));
    backfillEnv('DB_NAME', db.database);
    backfillEnv('DB_TYPE', db.type);
  }

  const ftp = config.fileTransfer.ftp;
  const ftpReady =
    readEnv('FTP_HOST') !== undefined ||
    (readEnv('FTP_USER') !== undefined && readEnv('FTP_PASS') !== undefined);
  if (ftpReady) {
    backfillEnv('FTP_HOST', ftp.host);
    backfillEnv('FTP_PORT', String(ftp.port));
    backfillEnv('FTP_PROTOCOL', ftp.protocol);
    backfillEnv('FTP_FILE_PATH', ftp.baseDir);
  }

  const names = config.dataSourceNames;
  backfillEnv('QUERY_SOURCE_TYPE', names.query.type);
  backfillEnv('QUERY_SOURCE_NAME', names.query.name);
  backfillEnv('QUERY_SCHEMA', names.query.schema);
  backfillEnv('FILE_AUTO_SOURCE_TYPE', names.fileAccess.type);
  backfillEnv('FILE_AUTO_SOURCE_NAME', names.fileAccess.name);
  backfillEnv('FILE_AUTO_DATABASE', names.fileAccess.database);
  backfillEnv('FILE_AUTO_SCHEMA', names.fileAccess.schema);
  backfillEnv('FILE_ACCESS_SAMPLE_PATH', names.fileAccess.samplePath);
  backfillEnv('FILE_EXISTING_TABLE', names.fileAccessExisting.table ?? '');
  backfillEnv('DATA_SYNC_SOURCE_TYPE', names.dataSyncSource.type);
  backfillEnv('DATA_SYNC_SOURCE_NAME', names.dataSyncSource.name);
  backfillEnv('DATA_SYNC_SOURCE_DATABASE', names.dataSyncSource.database);
  backfillEnv('DATA_SYNC_SOURCE_SCHEMA', names.dataSyncSource.schema);
  backfillEnv('DATA_SYNC_SOURCE_TABLE', names.dataSyncSource.table ?? '');
  backfillEnv('DATA_SYNC_TARGET_TYPE', names.dataSyncTarget.type);
  backfillEnv('DATA_SYNC_TARGET_NAME', names.dataSyncTarget.name);
  backfillEnv('DATA_SYNC_TARGET_DATABASE', names.dataSyncTarget.database);
  backfillEnv('DATA_SYNC_TARGET_SCHEMA', names.dataSyncTarget.schema);
  backfillEnv('DATA_SYNC_VERIFIED_TASK', names.dataSyncVerifiedTask);
  backfillEnv('EXPORT_SOURCE_TYPE', names.exportSource.type);
  backfillEnv('EXPORT_SOURCE_NAME', names.exportSource.name);
  backfillEnv('EXPORT_DATABASE', names.exportSource.database);
  backfillEnv('EXPORT_SCHEMA', names.exportSource.schema);
  backfillEnv('EXPORT_SOURCE_TABLE', names.exportSource.table ?? '');
  backfillEnv('API_DATA_SOURCE_TYPE', names.apiService.type);
  backfillEnv('API_DATA_SOURCE_NAME', names.apiService.name);
  backfillEnv('API_DATABASE', names.apiService.database);
  backfillEnv('API_SCHEMA', names.apiService.schema);
  backfillEnv('API_TABLE', names.apiService.table ?? '');
  backfillEnv('TABLE_NEW_DATABASE', names.tableManagement.newDataBase);
  backfillEnv('GAUSS_SOURCE_NAME', names.gaussSourceName);
  backfillEnv('GBASE_SOURCE_NAME', names.gbaseSourceName);
}

// ==================== 最小校验（错误消息只含变量名，不含任何值） ====================

function missingEnvNames(items: readonly (readonly [string, boolean])[]): string[] {
  return items.filter(([, present]) => !present).map(([name]) => name);
}

function throwIfMissing(scope: string, missing: string[], hint: string): void {
  if (missing.length === 0) return;
  throw new Error(
    `E2E 环境校验失败（E2E_ENV_PROFILE=${testEnvironment.profile}，${scope}）：` +
      `缺少 ${missing.join('、')}。${hint}`,
  );
}

/** 主 MySQL（110）连接校验：需要直连 DB 校验时使用。 */
export function requirePrimaryDatabase(): DatabaseConnectionConfig {
  const db = testEnvironment.databases.primary;
  throwIfMissing(
    '主 MySQL 连接',
    missingEnvNames([
      ['DB_HOST', !!db.host],
      ['DB_PORT', db.port > 0],
      ['DB_NAME', !!db.database],
      ['DB_USER', !!db.username],
      ['DB_PASS', !!db.password],
    ]),
    '数据库真实凭据只能通过进程环境变量提供，不要写入代码或脚本仓库。',
  );
  return db;
}

/** 113 第二数据源连接校验：仅明确需要第二数据源的用例使用。 */
export function requireSecondary113Database(): DatabaseConnectionConfig {
  const db = testEnvironment.databases.secondary113;
  throwIfMissing(
    '113 第二数据源连接',
    missingEnvNames([
      ['DB113_HOST（默认 192.168.76.113）', !!db.host],
      ['DB113_DATABASE（默认 e2e_test）', !!db.database],
      ['DB113_USER 或 DB_USER', !!db.username],
      ['DB113_PASS 或 DB_PASS', !!db.password],
    ]),
    '数据库真实凭据只能通过进程环境变量提供，不要写入代码或脚本仓库。',
  );
  return db;
}

/** FTP 传输 profile 校验：需要真实 FTP 操作的用例使用。 */
export function requireFtpProfile(): FileTransferProfileConfig {
  const ftp = testEnvironment.fileTransfer.ftp;
  throwIfMissing(
    'FTP 传输 profile',
    missingEnvNames([
      ['FTP_HOST', !!ftp.host],
      ['FTP_PORT', ftp.port > 0],
      ['FTP_USER', !!ftp.username],
      ['FTP_PASS', !!ftp.password],
    ]),
    'FTP 真实凭据只能通过进程环境变量提供，不要写入代码或脚本仓库。',
  );
  return ftp;
}

/** SFTP 传输 profile 校验：需要真实 SFTP 操作的用例使用。 */
export function requireSftpProfile(): FileTransferProfileConfig {
  const sftp = testEnvironment.fileTransfer.sftp;
  throwIfMissing(
    'SFTP 传输 profile',
    missingEnvNames([
      ['SFTP_HOST', !!sftp.host],
      ['SFTP_PORT', sftp.port > 0],
      ['SFTP_USER', !!sftp.username],
      ['SFTP_PASS', !!sftp.password],
    ]),
    'SFTP 真实凭据只能通过进程环境变量提供，不要写入代码或脚本仓库。',
  );
  return sftp;
}

/**
 * 主 MySQL 连接（可空）：保留旧 dbConfig() 的“未配置即跳过”语义——
 * 既未显式指定 DB_HOST、也未提供 DB 凭据时返回 null，调用方据此跳过 DB 校验。
 */
export function primaryDatabaseOrNull(): DatabaseConnectionConfig | null {
  const dbReady =
    readEnv('DB_HOST') !== undefined ||
    (readEnv('DB_USER') !== undefined && readEnv('DB_PASS') !== undefined);
  return dbReady ? testEnvironment.databases.primary : null;
}


// ==================== 对外入口 ====================

let cachedConfig: TestEnvironmentConfig | undefined;

/** 解析（并缓存）当前环境配置；首次调用同时执行兼容回填。 */
export function resolveTestEnvironment(): TestEnvironmentConfig {
  if (!cachedConfig) {
    cachedConfig = buildConfig();
    applyLegacyEnvBackfill(cachedConfig);
  }
  return cachedConfig;
}

/** 模块加载即解析：未迁移的旧用例在读取 process.env 前即可看到回填后的兼容变量。 */
export const testEnvironment: TestEnvironmentConfig = resolveTestEnvironment();

