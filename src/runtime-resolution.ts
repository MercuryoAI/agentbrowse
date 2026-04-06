export type RuntimeSource = 'dom' | 'stagehand';

export type RuntimeResolution = {
  source: RuntimeSource;
  degraded: boolean;
  degradationReason?: string;
};

export function domRuntimeResolution(): RuntimeResolution {
  return {
    source: 'dom',
    degraded: false,
  };
}

export function stagehandRuntimeResolution(degradationReason?: string): RuntimeResolution {
  if (!degradationReason) {
    return {
      source: 'stagehand',
      degraded: false,
    };
  }

  return {
    source: 'stagehand',
    degraded: true,
    degradationReason,
  };
}
