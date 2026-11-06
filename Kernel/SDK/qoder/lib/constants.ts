/**
 * Qoder constants — endpoints, region bases, and COSY signing parameters.
 *
 * Deliberately free of `node:crypto`: the SDK barrel is imported by the dashboard, so nothing here may
 * reach a Node builtin (see `tests/sdk-browser-safety.test.js`). The signing itself — AES, RSA and MD5 —
 * lives in the gateway, which injects it into the adapter.
 */

export const QODER_IDE_VERSION = '1.0.0';
export const QODER_CLIENT_TYPE = '5';
export const QODER_DATA_POLICY = 'disagree';
export const QODER_LOGIN_VERSION = 'v2';
export const QODER_MACHINE_OS = 'x86_64_windows';
export const QODER_MACHINE_TYPE = '5';

export const QODER_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

export const QODER_REGION_INTL = 'intl' as const;
export const QODER_REGION_CN = 'cn' as const;

export const QODER_CHAT_BASE_INTL = 'https://api3.qoder.sh';
export const QODER_CHAT_BASE_INTL_ALT = 'https://api2.qoder.sh';
export const QODER_CHAT_BASE_CN = 'https://gateway.qoder.com.cn';

const QODER_REGION_BASES: Record<'intl' | 'cn', { chat: string; chatAlt: string; openApi: string; center: string; login: string }> = {
  intl: {
    chat: QODER_CHAT_BASE_INTL,
    chatAlt: QODER_CHAT_BASE_INTL_ALT,
    openApi: 'https://openapi.qoder.sh',
    center: 'https://center.qoder.sh',
    login: 'https://qoder.com/device/selectAccounts',
  },
  cn: {
    chat: QODER_CHAT_BASE_CN,
    chatAlt: QODER_CHAT_BASE_CN,
    openApi: 'https://openapi.qoder.com.cn',
    center: 'https://gateway.qoder.com.cn',
    login: 'https://qoder.com.cn/device/selectAccounts',
  },
};

export const QODER_CHAT_SIG_PATH = '/algo/api/v2/service/pro/sse/agent_chat_generation';
export const QODER_MODEL_LIST_PATH = '/algo/api/v2/model/list';

export const QODER_MODEL_MAP: Record<string, string> = {
  auto: 'auto',
  ultimate: 'ultimate',
  performance: 'performance',
  efficient: 'efficient',
  lite: 'lite',
  qmodel: 'qmodel',
  qfmodel: 'qfmodel',
  qmodel_latest: 'qmodel_latest',
  qmodel_38max: 'qmodel_38max',
  dmodel: 'dmodel',
  dfmodel: 'dfmodel',
  gmodel: 'gmodel',
  gfmodel: 'gfmodel',
  kmodel: 'kmodel',
  mmodel: 'mmodel',
};

export function qoderRegionOf(providerId: string): 'intl' | 'cn' {
  return providerId.endsWith('-cn') ? QODER_REGION_CN : QODER_REGION_INTL;
}

export function qoderLoginUrl(region: 'intl' | 'cn'): string {
  return QODER_REGION_BASES[region].login;
}

export function qoderDeviceTokenUrl(region: 'intl' | 'cn'): string {
  return `${QODER_REGION_BASES[region].openApi}/api/v1/deviceToken/poll`;
}

export function qoderUserInfoUrl(region: 'intl' | 'cn'): string {
  return `${QODER_REGION_BASES[region].openApi}/api/v1/userinfo`;
}

export function qoderModelListUrl(region: 'intl' | 'cn'): string {
  return `${QODER_REGION_BASES[region].chat}${QODER_MODEL_LIST_PATH}`;
}

export function qoderInferenceBase(region: 'intl' | 'cn', credential?: { accessToken?: string }): string {
  if (region === QODER_REGION_CN) return QODER_REGION_BASES[region].chat;
  const raw = credential?.accessToken;
  if (typeof raw === 'string' && raw.startsWith('jt-')) return QODER_CHAT_BASE_INTL_ALT;
  return QODER_CHAT_BASE_INTL;
}

export function qoderBuildChatUrl(region: 'intl' | 'cn', credential?: { accessToken?: string }): string {
  return `${qoderInferenceBase(region, credential)}${QODER_CHAT_SIG_PATH}?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`;
}
