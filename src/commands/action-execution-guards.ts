export type ActionExecutionGuards = {
  assertStillValid?: (stage: string) => Promise<void>;
};

export async function runActionExecutionGuard(
  guards: ActionExecutionGuards | undefined,
  stage: string
): Promise<void> {
  await guards?.assertStillValid?.(stage);
}
