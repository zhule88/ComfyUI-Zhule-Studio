import { app } from "../../scripts/app.js";

const NODE_NAME = "ZhuleSaveImage";
const INPUT_PREFIX = "link_";
const MIN_INPUTS = 1;
const MAX_INPUTS = 16;

function isLinkInput(input) {
    return input?.name?.startsWith(INPUT_PREFIX);
}

function inputNumber(input) {
    const value = Number.parseInt(input.name.slice(INPUT_PREFIX.length), 10);
    return Number.isFinite(value) ? value : 0;
}

function linkInputs(node) {
    return (node.inputs ?? []).filter(isLinkInput);
}

function addLinkInput(node) {
    const inputs = linkInputs(node);
    if (inputs.length >= MAX_INPUTS) return false;

    const nextNumber = inputs.reduce(
        (highest, input) => Math.max(highest, inputNumber(input)),
        0,
    ) + 1;

    node.addInput(`${INPUT_PREFIX}${nextNumber}`, "STRING");
    return true;
}

function resizeNode(node) {
    const computed = node.computeSize();
    node.setSize([Math.max(node.size[0], computed[0]), computed[1]]);
    app.graph?.setDirtyCanvas(true, true);
}

function stabilizeInputs(node) {
    if (node._zhuleSaveStabilizing) return;
    node._zhuleSaveStabilizing = true;

    try {
        // 确保至少有 MIN_INPUTS 个
        let inputs = linkInputs(node);
        while (inputs.length < MIN_INPUTS) {
            if (!addLinkInput(node)) break;
            inputs = linkInputs(node);
        }

        // 找最高已连接的 link
        let highestConnected = -1;
        inputs.forEach((input, index) => {
            if (input.link != null) highestConnected = index;
        });

        // 目标：max(MIN, 最高连接 + 2)
        const targetCount = Math.min(
            MAX_INPUTS,
            Math.max(MIN_INPUTS, highestConnected + 2),
        );

        // 删多余的
        while (inputs.length > targetCount) {
            const last = inputs.at(-1);
            const nodeIndex = node.inputs.indexOf(last);
            if (nodeIndex < 0 || last.link != null) break;
            node.removeInput(nodeIndex);
            inputs = linkInputs(node);
        }

        // 补不足的
        while (inputs.length < targetCount) {
            if (!addLinkInput(node)) break;
            inputs = linkInputs(node);
        }

        resizeNode(node);
    } finally {
        node._zhuleSaveStabilizing = false;
    }
}

function scheduleStabilize(node) {
    window.setTimeout(() => stabilizeInputs(node), 0);
}

app.registerExtension({
    name: "Zhule.SaveImage.DynamicLinks",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;

        // 从 nodeData 里删掉 link_2 ~ link_16，初始只显示 link_1
        const optional = nodeData.input?.optional;
        if (optional) {
            for (let i = MIN_INPUTS + 1; i <= MAX_INPUTS; i += 1) {
                delete optional[`${INPUT_PREFIX}${i}`];
            }
        }

        const originalCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = originalCreated?.apply(this, arguments);
            scheduleStabilize(this);
            return result;
        };

        const originalConfigured = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const result = originalConfigured?.apply(this, arguments);
            scheduleStabilize(this);
            return result;
        };

        const originalConnectionsChange = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function () {
            const result = originalConnectionsChange?.apply(this, arguments);
            scheduleStabilize(this);
            return result;
        };
    },
});