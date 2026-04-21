// Extension that reads stdin but never responds — used to test timeouts
async function main() {
  const reader = Bun.stdin.stream().getReader();
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
}

main();
