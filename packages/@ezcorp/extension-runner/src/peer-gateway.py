import asyncio
import errno
import os
import socket
import stat
import struct
import sys


async def main():
    public_path, private_path, expected_uid = sys.argv[1:]
    semaphore = asyncio.Semaphore(32)
    if os.path.lexists(public_path):
        previous = os.lstat(public_path)
        if not stat.S_ISSOCK(previous.st_mode) or previous.st_uid != os.getuid():
            raise RuntimeError("Runner socket path is not an owned socket")
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
            probe.settimeout(1)
            try:
                probe.connect(public_path)
            except OSError as error:
                if error.errno != errno.ECONNREFUSED:
                    raise
                if os.lstat(public_path).st_ino != previous.st_ino:
                    raise RuntimeError("Runner socket changed during recovery")
                os.unlink(public_path)
            else:
                raise RuntimeError("Runner socket is already active")

    async def connection(reader, writer):
        peer = writer.get_extra_info("socket")
        _, uid, _ = struct.unpack("3i", peer.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        if uid != int(expected_uid) or semaphore.locked():
            writer.close()
            await writer.wait_closed()
            return
        async with semaphore:
            upstream = None
            try:
                upstream_reader, upstream = await asyncio.open_unix_connection(private_path)

                async def relay(source, destination):
                    while True:
                        chunk = await asyncio.wait_for(source.read(65536), timeout=360)
                        if not chunk:
                            return
                        destination.write(chunk)
                        await destination.drain()

                tasks = [asyncio.create_task(relay(reader, upstream)), asyncio.create_task(relay(upstream_reader, writer))]
                _, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for task in pending:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
            except (OSError, asyncio.TimeoutError):
                pass
            finally:
                writer.close()
                if upstream:
                    upstream.close()
                await writer.wait_closed()

    server = await asyncio.start_unix_server(connection, public_path, limit=65536)
    os.chown(public_path, -1, os.stat(os.path.dirname(public_path)).st_gid)
    os.chmod(public_path, 0o660)
    print("READY", flush=True)
    async with server:
        await server.serve_forever()


asyncio.run(main())
