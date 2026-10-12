import { app } from "../../scripts/app.js";

console.log("%c[ZhuleParamSweep] LOADED", "color:#0f0;font-weight:bold");

const NODE_TYPE = "ZhuleParamSweep";

app.registerExtension({
  name: "Zhule.ParamSweep",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_TYPE) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = onNodeCreated?.apply(this, arguments);
      const node = this;

      function setWidget(name, value) {
        const w = node.widgets?.find(x => x.name === name);
        if (!w) {
          console.log(`[ZhuleParamSweep] widget 未找到: ${name}`);
          return;
        }

        console.log(`[ZhuleParamSweep] 更新 ${name}: ${w.value} → ${value}`);

        w.value = value;
        if (w.inputEl) w.inputEl.value = value;
        if (w.element) w.element.value = value;

        node.graph?.setDirtyCanvas(true, true);
      }

      node.onExecuted = function (message) {
        console.log("[ZhuleParamSweep] onExecuted", message);

        const curSteps = message?.current_steps?.[0];
        const curCfg = message?.current_cfg?.[0];
        const curSampler = message?.current_sampler?.[0];
        const curScheduler = message?.current_scheduler?.[0];

        const sweepParam = node.widgets?.find(w => w.name === "sweep_param")?.value;

        if (sweepParam === "steps" && curSteps !== undefined) {
          setWidget("step_current", curSteps);
        } else if (sweepParam === "cfg" && curCfg !== undefined) {
          setWidget("cfg_current", curCfg);
        } else if (
          (sweepParam === "sampler_name" ||
            sweepParam === "scheduler" ||
            sweepParam === "sampler × scheduler")
          && curSampler !== undefined && curScheduler !== undefined
        ) {
          const combo = `${curSampler}|${curScheduler}`;
          setWidget("start_combo", combo);
        }
      };

      return result;
    };
  },
});