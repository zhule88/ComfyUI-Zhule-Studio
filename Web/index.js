async function loadModules() {
    const res = await fetch("/zhule_modules");
    const names = await res.json();
    // 并行发起所有模块 import，避免串行 await 使排位靠后的模块
    // 错过 ComfyUI 节点注册窗口（beforeRegisterNodeDef 不被执行）
    await Promise.allSettled(
        names.map((name) =>
            import(`/zhule_modules/${name}/${name}.js`).catch((e) =>
                console.error(`[Zhule] 加载模块 ${name} 失败`, e),
            ),
        ),
    );
}
loadModules();
