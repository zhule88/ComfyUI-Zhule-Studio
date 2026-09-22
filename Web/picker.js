import { app } from "../../scripts/app.js";

app.registerExtension({
    name: "Zhule.Picker.DynamicMode",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "ZhulePicker") return;

        function setEnabled(w, enabled) {
            if (!w) return;
            if (w._state) w._state.disabled = !enabled;
        }

        function updateVisibility(node) {
            const modeWidget = node.widgets?.find(w => w.name === "mode");
            if (!modeWidget) return;

            const isProb = modeWidget.value === "probability";

            const probWidget = node.widgets?.find(w => w.name === "probability");
            const condWidget = node.widgets?.find(w => w.name === "condition");
            const elseWidget = node.widgets?.find(w => w.name === "else_text");

            setEnabled(probWidget, isProb);
            setEnabled(condWidget, !isProb);
            setEnabled(elseWidget, !isProb);

            app.graph.setDirtyCanvas(true, true);
        }

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);
            const node = this;
            const modeWidget = node.widgets?.find(w => w.name === "mode");
            if (modeWidget) {
                const orig = modeWidget.callback;
                modeWidget.callback = function (value) {
                    orig?.apply(this, arguments);
                    updateVisibility(node);
                };
            }
            setTimeout(() => updateVisibility(node), 200);
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            onConfigure?.apply(this, arguments);
            const node = this;
            setTimeout(() => updateVisibility(node), 300);
        };
    }
});