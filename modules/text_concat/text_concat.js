import { app } from "../../scripts/app.js";

const NODE_NAME = "ZhuleTextConcatenate";
const INPUT_PREFIX = "text_";
const MIN_INPUTS = 2;
const MAX_INPUTS = 16;

function isTextInput(input) {
    return input?.name?.startsWith(INPUT_PREFIX);
}

function inputNumber(input) {
    const value = Number.parseInt(input.name.slice(INPUT_PREFIX.length), 10);
    return Number.isFinite(value) ? value : 0;
}

function textInputs(node) {
    return (node.inputs ?? []).filter(isTextInput);
}

function addTextInput(node) {
    const inputs = textInputs(node);
    if (inputs.length >= MAX_INPUTS) {
        return false;
    }

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
    if (node._zhuleConcatStabilizing) {
        return;
    }
    node._zhuleConcatStabilizing = true;

    try {
        // 保证至少 MIN_INPUTS 个
        let inputs = textInputs(node);
        while (inputs.length < MIN_INPUTS) {
            if (!addTextInput(node)) break;
            inputs = textInputs(node);
        }

        // 找最高已连接的槽的索引
        let highestConnected = -1;
        inputs.forEach((input, index) => {
            if (input.link != null) {
                highestConnected = index;
            }
        });

        // 目标数量 = max(MIN, 最高连接 + 2)
        const targetCount = Math.min(
            MAX_INPUTS,
            Math.max(MIN_INPUTS, highestConnected + 2),
        );

        // 多了就删
        while (inputs.length > targetCount) {
            const last = inputs.at(-1);
            const nodeIndex = node.inputs.indexOf(last);
            if (nodeIndex < 0 || last.link != null) {
                break;
            }
            node.removeInput(nodeIndex);
            inputs = textInputs(node);
        }

        // 少了就加
        while (inputs.length < targetCount) {
            if (!addTextInput(node)) break;
            inputs = textInputs(node);
        }

        resizeNode(node);
    } finally {
        node._zhuleConcatStabilizing = false;
    }
}

function scheduleStabilize(node) {
    window.setTimeout(() => stabilizeInputs(node), 0);
}

app.registerExtension({
    name: "Zhule.DynamicTextConcatenate",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) {
            return;
        }

        // 后端声明了 text_1 ~ text_16
        // 前端初始只显示 text_1、text_2，其余从 nodeData.input.optional 里删掉
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