/** Production authority paths are fixed. Only the test bundle accepts an injected state path. */
declare const __JEV_TEST_CONTROL_BUILD__: boolean | undefined;

const productionStatePath = "/var/lib/jeverb/control-state.json";
export const PROTECTED_MASTER_SWITCH_PATH =
  typeof __JEV_TEST_CONTROL_BUILD__ !== "undefined" && __JEV_TEST_CONTROL_BUILD__
    ? (process.env.JEV_TEST_CONTROL_STATE_PATH ?? productionStatePath)
    : productionStatePath;
export function protectedMasterSwitchPath(env: NodeJS.ProcessEnv = process.env): string {
  return typeof __JEV_TEST_CONTROL_BUILD__ !== "undefined" && __JEV_TEST_CONTROL_BUILD__
    ? (env.JEV_TEST_CONTROL_STATE_PATH ?? productionStatePath)
    : productionStatePath;
}
/** True in shipped/library code; false only in the test-only hook bundle. */
export const REQUIRE_ROOT_OWNED_SWITCH =
  typeof __JEV_TEST_CONTROL_BUILD__ === "undefined" || !__JEV_TEST_CONTROL_BUILD__;
export const CONTROL_SOCKET_PATH =
  typeof __JEV_TEST_CONTROL_BUILD__ !== "undefined" && __JEV_TEST_CONTROL_BUILD__
    ? (process.env.JEV_TEST_CONTROL_SOCKET_PATH ?? "/run/jeverb-control/control.sock")
    : "/run/jeverb-control/control.sock";
