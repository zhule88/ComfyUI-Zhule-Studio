console.log("[Zhule] 开始加载模块");

const res = await fetch("/zhule_modules");
const names = await res.json();
console.log("[Zhule] 模块清单:", names);

await Promise.allSettled(
    names.map((name) =>
        import(`/zhule_modules/${name}/${name}.js`).catch((e) =>
            console.error(`[Zhule] 加载模块 ${name} 失败`, e),
        ),
    ),
);

console.log("[Zhule] 所有模块加载完成");
