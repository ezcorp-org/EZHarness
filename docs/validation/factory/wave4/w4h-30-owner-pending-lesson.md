# W4H-30 pending lessons (owner)

- A descriptor-count flake is a question of ownership, not of tolerance. Record, at each sample, every socket with its
  table line and its peer (ss in the app network namespace), and log the requests in flight. Here the two "growing"
  sockets were idle keep-alive connections to runner.sock with no request in flight: node:http's default agent kept each
  finished call's connection for about 5 s, so a sample counted one or two by timing alone.
- A red test for a keep-alive pool must not wait out the idle timeout. My first hypothesis test waited until the socket
  count fell and so passed on the old code. The deterministic red is the request header: every call sends
  "Connection: close" (agent: false). Keep the end-to-end settle test as well, through the real service and gateway.
- Bun's lcov can give a comment line inside an object literal a 0-hit record. The patch gate then counts the comment as an
  uncovered changed line. Put a reason on the executed line, or above the statement, not between object properties.
