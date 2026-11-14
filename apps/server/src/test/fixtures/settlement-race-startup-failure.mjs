// null请求的真实child在ready前失败；另一个请求可作为等待屏障的存活peer。
if (process.argv[5] === "null") {
  process.stderr.write("settlement-startup-marker: ready前启动失败\n");
  process.exit(1);
}
process.on("message", () => {});
process.send?.({ ready: true });
