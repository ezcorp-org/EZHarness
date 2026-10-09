#!/usr/bin/env python3
"""Real static-asset checks and compiled C boundary/fault tests. No pressure load."""

import hashlib, json, os, pathlib, resource, subprocess, tempfile, unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
SOURCE = ROOT / "src/infrastructure/incus-guest/memory-stress.c"
ASSET = SOURCE.with_name("memory-stress.x86_64.bin")
METADATA = SOURCE.with_name("memory-stress.build.json")
# The harness injects only kernel/libc boundaries. It includes and executes the
# checked-in C itself; gcov measures that same source, never generated DA data.
HARNESS = r"""
#define _GNU_SOURCE
#include <assert.h>
#include <errno.h>
#include <inttypes.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/resource.h>
#include <unistd.h>
static int map_mode,status_mode,smaps_mode,page_bad,limit_bad,score_bad,put_bad,close_bad,lock_bad,mmap_bad,unmap_bad,status_reads;
static unsigned char payload[8192];
static FILE *score;
static FILE *fake_fopen(const char *path,const char *mode){
 static char data[4096];
 if(!strcmp(path,"/proc/self/maps")){
  if(map_mode==1){errno=EACCES;return NULL;}
  if(map_mode==2)strcpy(data,"malformed\n");
  else if(map_mode==3){memset(data,'a',sizeof(data)-2);data[sizeof(data)-2]='\n';data[sizeof(data)-1]=0;}
  else if(map_mode==4)strcpy(data,"0-ffffffffffffffff r-xp\n0-2 r-xp\n");
  else if(map_mode==5)strcpy(data,"0-200000 r-xp\n");
  else strcpy(data,"00400000-00401000 r-xp 0 0 0\n");
 }else if(!strcmp(path,"/proc/self/status")){
  status_reads++;
  if(status_mode==1){errno=EACCES;return NULL;}
  if(status_mode==2)strcpy(data,"Name: fixture\n");
  else if(status_mode==3)strcpy(data,"VmLck: 2048 kB\n");
  else if(status_mode==4)strcpy(data,"VmLck: 0 kB\n");
  else if(status_mode==5&&status_reads>=3)strcpy(data,"VmLck: 8 kB\n");
  else strcpy(data,"VmLck: 4 kB\n");
 }else if(!strcmp(path,"/proc/self/smaps")){
  if(smaps_mode==1){errno=EACCES;return NULL;}
  if(smaps_mode==2)strcpy(data,"1-2 r-xp\nLocked: 0 kB\n");
  else if(smaps_mode==3){memset(data,'a',sizeof(data)-2);data[sizeof(data)-2]='\n';data[sizeof(data)-1]=0;}
  else snprintf(data,sizeof data,"%lx-%lx rw-p\nLocked: %d kB\n",(unsigned long)(uintptr_t)payload,(unsigned long)(uintptr_t)payload+sizeof payload,smaps_mode==4?1:0);
 }else{
  assert(!strcmp(path,"/proc/self/oom_score_adj"));
  if(score_bad){errno=EACCES;return NULL;}
  score=tmpfile();return score;
 }
 assert(!strcmp(mode,"r"));return fmemopen(data,strlen(data),"r");
}
static int fake_fputs(const char *s,FILE *f){assert(f==score&&!strcmp(s,"500"));if(put_bad){errno=EIO;fclose(f);return EOF;}return fputs(s,f);}
static int fake_fclose(FILE *f){int result=fclose(f);if(f==score&&close_bad){errno=EIO;return EOF;}return result;}
static long fake_sysconf(int name){assert(name==_SC_PAGESIZE);return page_bad?-1:4096;}
static int fake_getrlimit(int which,struct rlimit *r){assert(which==RLIMIT_MEMLOCK);if(limit_bad){errno=EPERM;return -1;}r->rlim_cur=1048576;r->rlim_max=1048576;return 0;}
static int fake_mlockall(int flags){assert(flags==MCL_CURRENT);if(lock_bad){errno=ENOMEM;return -1;}return 0;}
static void *fake_mmap(void *a,size_t size,int prot,int flags,int fd,off_t offset){assert(!a&&size<=sizeof payload&&prot==(PROT_READ|PROT_WRITE)&&flags==(MAP_PRIVATE|MAP_ANONYMOUS)&&fd==-1&&!offset);if(mmap_bad){errno=ENOMEM;return MAP_FAILED;}return payload;}
static int fake_munmap(void *p,size_t size){assert(p==payload&&size<=sizeof payload);if(unmap_bad){errno=EINVAL;return -1;}return 0;}
static unsigned fake_sleep(unsigned n){assert(n==1);return 0;}
#define fopen fake_fopen
#define fputs fake_fputs
#define fclose fake_fclose
#define sysconf fake_sysconf
#define getrlimit fake_getrlimit
#define mlockall fake_mlockall
#define mmap fake_mmap
#define munmap fake_munmap
#define sleep fake_sleep
#define main native_main
#include "SOURCE_PATH"
#undef main
static void reset(void){map_mode=status_mode=smaps_mode=page_bad=limit_bad=score_bad=put_bad=close_bad=lock_bad=mmap_bad=unmap_bad=status_reads=0;score=NULL;}
static int run(const char *arg){char *args[]={"memory-stress",(char*)arg};return native_main(2,args);}
int main(void){
 char *args[]={"memory-stress"};assert(native_main(1,args)==2);
 const char *bad[]={"","0","-1","x","18446744073709551616","68719476737"};
 for(size_t n=0;n<sizeof bad/sizeof *bad;n++){reset();assert(run(bad[n])==2);}
 unsigned long a,b;
 assert(kilobytes("VmLck: 224 kB\n","VmLck:")==229376);
 assert(kilobytes("Locked:\t0 kB\n","Locked:")==0);
 const char *badkb[]={"VmLck: -1 kB\n","VmLck: +1 kB\n","VmLck: 1 MB\n","VmLck: 1 kB trailing\n","VmLck: 1 kB","VmLck: 18446744073709551616 kB\n","VmLck: 18446744073709551615 kB\n","VmLck: 1.5 kB\n","Locked: 1 kB\n","VmLck: kB\n"};
 for(size_t n=0;n<sizeof badkb/sizeof *badkb;n++)assert(kilobytes(badkb[n],"VmLck:")==ULONG_MAX);
 assert(span("00400000-00401000 r-xp 0000 00:00 0\n",&a,&b));assert(a==0x400000&&b==0x401000);
 const char *badspan[]={"","-1-2 r-xp\n","1-0 r-xp\n","1-2x r-xp\n","1- r-xp\n","fffffffffffffffff-fffffffffffffffff r-xp\n","1-fffffffffffffffff r-xp\n","Anonymous: 1 kB\n","f-g r-xp\n"};
 for(size_t n=0;n<sizeof badspan/sizeof *badspan;n++)assert(!span(badspan[n],&a,&b));
 reset();assert(run("4096")==0);assert(payload[0]==1);
 reset();page_bad=1;assert(run("4096")==2);
 reset();limit_bad=1;assert(run("4096")==2);
 for(int mode=1;mode<=5;mode++){reset();map_mode=mode;assert(run("4096")==2);}
 reset();score_bad=1;assert(run("4096")==2);
 reset();put_bad=1;assert(run("4096")==2);
 reset();close_bad=1;assert(run("4096")==2);
 reset();lock_bad=1;assert(run("4096")==2);
 for(int mode=1;mode<=5;mode++){reset();status_mode=mode;assert(run("4096")==2);}
 reset();mmap_bad=1;assert(run("4096")==2);
 for(int mode=1;mode<=4;mode++){reset();smaps_mode=mode;assert(run("4096")==2);}
 reset();assert(payload_locked((void*)UINTPTR_MAX,4096)==ULONG_MAX);
 reset();unmap_bad=1;assert(run("4096")==2);
 puts("compiled native boundary assertions passed");return 0;
}
"""


def compile_boundary(directory, coverage=False):
    directory = pathlib.Path(directory)
    harness = directory / "boundary.c"
    harness.write_text(HARNESS.replace("SOURCE_PATH", str(SOURCE)))
    output = directory / "boundary"
    flags = ["--coverage", "-fprofile-abs-path"] if coverage else []
    subprocess.run(
        ["gcc", "-O0", "-Wall", "-Wextra", *flags, str(harness), "-o", str(output)],
        check=True,
        capture_output=True,
    )
    return output


class NativeTests(unittest.TestCase):
    def test_checked_asset_source_hash_size_and_static_elf(self):
        metadata = json.loads(METADATA.read_text())
        data = ASSET.read_bytes()
        self.assertEqual(
            hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
            metadata["source"]["sha256"],
        )
        self.assertEqual(
            hashlib.sha256(data).hexdigest(), metadata["artifact"]["sha256"]
        )
        self.assertEqual(len(data), metadata["artifact"]["bytes"])
        self.assertLessEqual(len(data), 65536)
        self.assertEqual(data[:4], b"\x7fELF")
        self.assertEqual(int.from_bytes(data[18:20], "little"), 62)
        start = int.from_bytes(data[32:40], "little")
        size = int.from_bytes(data[54:56], "little")
        count = int.from_bytes(data[56:58], "little")
        self.assertFalse(
            any(
                int.from_bytes(data[start + n * size : start + n * size + 4], "little")
                == 3
                for n in range(count)
            )
        )
        self.assertFalse(metadata["runtime"]["compilerRequired"])
        self.assertEqual(metadata["lock"]["mode"], "MCL_CURRENT")

    def test_real_payload_unlocked_and_control_bounded(self):
        for size in (1, 4096, 65537):
            p = subprocess.Popen(
                [str(ASSET), str(size)],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            try:
                control = json.loads(p.stdout.readline())
                mapped = json.loads(p.stdout.readline())
                touched = json.loads(p.stdout.readline())
                self.assertEqual(mapped["payloadLockedBytes"], 0)
                self.assertEqual(mapped["lockedBytes"], control["lockedBytes"])
                self.assertGreater(control["lockedBytes"], 0)
                self.assertLessEqual(control["lockedBytes"], 1048576)
                self.assertEqual(touched["lockedBytes"], control["lockedBytes"])
                address = int(mapped["address"], 16)
                active = False
                locked = None
                for line in (
                    pathlib.Path(f"/proc/{p.pid}/smaps").read_text().splitlines()
                ):
                    token = line.split()[0]
                    if "-" in token and all(c in "0123456789abcdef-" for c in token):
                        a, b = token.split("-")
                        active = int(a, 16) <= address < int(b, 16)
                    elif active and line.startswith("Locked:"):
                        locked = int(line.split()[1])
                self.assertEqual(locked, 0)
                _, err = p.communicate(timeout=5)
                self.assertEqual(p.returncode, 0, err)
            finally:
                if p.poll() is None:
                    p.kill()
                    p.wait()

    def test_zero_lock_limit_refuses_before_payload(self):
        def zero():
            resource.setrlimit(resource.RLIMIT_MEMLOCK, (0, 0))

        p = subprocess.run(
            [str(ASSET), "65537"],
            preexec_fn=zero,
            capture_output=True,
            text=True,
            timeout=5,
        )
        self.assertEqual(p.returncode, 2)
        self.assertEqual(p.stdout, "")
        self.assertEqual(json.loads(p.stderr)["phase"], "lock")

    def test_bad_targets_and_argument_count(self):
        for args in (
            [],
            ["0"],
            ["-1"],
            ["x"],
            ["18446744073709551616"],
            ["68719476737"],
        ):
            p = subprocess.run(
                [str(ASSET), *args], capture_output=True, text=True, timeout=5
            )
            self.assertEqual(p.returncode, 2)
            self.assertEqual(p.stdout, "")

    def test_compiled_actual_source_fault_boundaries(self):
        with tempfile.TemporaryDirectory() as directory:
            p = subprocess.run(
                [str(compile_boundary(directory))],
                capture_output=True,
                text=True,
                timeout=5,
            )
            self.assertEqual(p.returncode, 0, p.stderr)
            self.assertIn("compiled native boundary assertions passed", p.stdout)


if __name__ == "__main__":
    unittest.main()
