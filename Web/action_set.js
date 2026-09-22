import { app } from "../../scripts/app.js";

const MIN_INPUTS = 1;
const MAX_INPUTS = 12;

function getActionInputs(node) {
    const list = [];
    (node.inputs || []).forEach((inp, idx) => {
        if (inp.name && inp.name.startsWith("action_")) {
            const n = parseInt(inp.name.replace("action_", ""));
            if (!isNaN(n)) list.push({ inp, idx, n });
        }
    });
    list.sort((a, b) => a.n - b.n);
    return list;
}

function syncInputs(node) {
    const inputs = getActionInputs(node);
    if (inputs.length === 0) return;

    let maxConnected = 0;
    inputs.forEach(x => {
        const connected = x.inp.link !== null && x.inp.link !== undefined;
        if (connected) maxConnected = Math.max(maxConnected, x.n);
    });

    const desired = Math.min(MAX_INPUTS, Math.max(MIN_INPUTS, maxConnected + 1));
    const current = inputs.length;

    if (current < desired) {
        for (let i = current + 1; i <= desired; i++) {
            node.addInput(`action_${i}`, "STRING");
        }
    } else if (current > desired) {
        for (let i = current - 1; i >= desired; i--) {
            node.removeInput(inputs[i].idx);
        }
    }

    const newSize = node.computeSize();
    node.setSize([Math.max(node.size[0], newSize[0]), newSize[1]]);
    app.graph.setDirtyCanvas(true, true);
}

app.registerExtension({
    name: "Zhule.ActionSet.DynamicInputs",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "ZhuleActionSet") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);
            const node = this;
            setTimeout(() => syncInputs(node), 50);
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            onConfigure?.apply(this, arguments);
            const node = this;
            setTimeout(() => syncInputs(node), 100);
        };

        const onConnectionsChange = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function (type, index, connected, link_info, io_slot) {
            onConnectionsChange?.apply(this, arguments);
            const node = this;
            if (type === 1) {
                requestAnimationFrame(() => syncInputs(node));
            }
        };
    }
});