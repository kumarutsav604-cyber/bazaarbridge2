import crypto from 'crypto';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

const DEFAULT_FEATURE_FLAGS = [
  'FEATURE_COUPONS',
  'FEATURE_WISHLIST',
  'FEATURE_ALERTS',
  'FEATURE_ADDRESSES',
  'FEATURE_SAVE_LATER',
  'FEATURE_COMPARE',
  'FEATURE_ASSISTANT',
  'FEATURE_REVIEWS',
  'FEATURE_SUPPORT',
  'FEATURE_SIM_SCREENS',
] as const;

export type FeatureFlagName = (typeof DEFAULT_FEATURE_FLAGS)[number];

export interface ServiceReadiness {
  postgresConfigured: boolean;
  kafkaConfigured: boolean;
  opensearchConfigured: boolean;
  geminiConfigured: boolean;
  allCoreConfigured: boolean;
  missingCore: string[];
}

function parseFeatureFlags(): Record<FeatureFlagName, boolean> {
  const raw = process.env.FEATURE_FLAGS;
  const activeSet = new Set<string>(
    raw !== undefined
      ? raw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : []
  );

  const result = {} as Record<FeatureFlagName, boolean>;
  for (const flag of DEFAULT_FEATURE_FLAGS) {
    const individual = process.env[flag];
    if (individual !== undefined) {
      result[flag] = individual.toLowerCase() === 'true' || individual === '1';
    } else if (raw !== undefined) {
      result[flag] = activeSet.has(flag);
    } else {
      // Optional features default ON when FEATURE_FLAGS is unset unless explicitly disabled
      result[flag] = true;
    }
  }
  return result;
}

const EPHEMERAL_JWT_SECRET = crypto.randomBytes(32).toString('hex');
const EPHEMERAL_OTP_SECRET = crypto.randomBytes(32).toString('hex');

export const env = {
  port: Number(process.env.PORT || 3000),
  nodeEnv: process.env.NODE_ENV || 'development',
  pgUri: process.env.PG_URI || '',
  kafkaBrokers: (process.env.KAFKA_BROKERS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  kafkaSecurityProtocol: (process.env.KAFKA_SECURITY_PROTOCOL || 'SASL_SSL').toUpperCase(),
  kafkaSaslMechanism: process.env.KAFKA_SASL_MECHANISM || 'SCRAM-SHA-256',
  kafkaSaslUsername: process.env.KAFKA_SASL_USERNAME || '',
  kafkaSaslPassword: process.env.KAFKA_SASL_PASSWORD || '',
  kafkaCaCert: process.env.KAFKA_CA_CERT || '',
  kafkaCaPath: process.env.KAFKA_CA_PATH || '',
  kafkaServiceCertPath: process.env.KAFKA_SERVICE_CERT_PATH || '',
  kafkaServiceKeyPath: process.env.KAFKA_SERVICE_KEY_PATH || '',
  opensearchUrl: process.env.OPENSEARCH_URL || '',
  opensearchUser: process.env.OPENSEARCH_USERNAME || process.env.OPENSEARCH_USER || '',
  opensearchPassword: process.env.OPENSEARCH_PASSWORD || process.env.OPENSEARCH_PASS || '',
  jwtSecret: process.env.JWT_SECRET || EPHEMERAL_JWT_SECRET,
  otpHashSecret: process.env.OTP_HASH_SECRET || EPHEMERAL_OTP_SECRET,
  seedAdminPassword: process.env.SEED_ADMIN_PASSWORD || '',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  frontendUrl: process.env.FRONTEND_URL || process.env.APP_URL || '',
  featureFlags: parseFeatureFlags(),
};

export function isFlagEnabled(flag: FeatureFlagName): boolean {
  return Boolean(env.featureFlags[flag]);
}

export function getServiceReadiness(): ServiceReadiness {
  const postgresConfigured = Boolean(env.pgUri);
  const needsSasl = env.kafkaSecurityProtocol.startsWith('SASL');
  const kafkaConfigured =
    env.kafkaBrokers.length > 0 &&
    (!needsSasl || (Boolean(env.kafkaSaslUsername) && Boolean(env.kafkaSaslPassword)));
  const opensearchConfigured = Boolean(env.opensearchUrl);
  const geminiConfigured = Boolean(env.geminiApiKey && env.geminiApiKey !== 'MY_GEMINI_API_KEY');

  const missingCore: string[] = [];
  if (!postgresConfigured) missingCore.push('PG_URI');
  if (env.kafkaBrokers.length === 0) {
    missingCore.push('KAFKA_BROKERS');
  } else if (needsSasl && !env.kafkaSaslPassword) {
    missingCore.push('KAFKA_SASL_PASSWORD');
  }
  if (!opensearchConfigured) missingCore.push('OPENSEARCH_URL');

  return {
    postgresConfigured,
    kafkaConfigured,
    opensearchConfigured,
    geminiConfigured,
    allCoreConfigured: postgresConfigured && kafkaConfigured && opensearchConfigured,
    missingCore,
  };
}

export function readOptionalCertFile(filePath: string): Buffer | undefined {
  if (!filePath) return undefined;
  const resolved = path.resolve(process.cwd(), filePath);
  if (fs.existsSync(resolved)) {
    return fs.readFileSync(resolved);
  }
  return undefined;
}

export function readOptionalCaCert(): Buffer | undefined {
  if (env.kafkaCaCert && env.kafkaCaCert.includes('BEGIN CERTIFICATE')) {
    return Buffer.from(env.kafkaCaCert.replace(/\\n/g, '\n'), 'utf8');
  }
  return readOptionalCertFile(env.kafkaCaPath);
}
