// Phase 3 — image builder. Stub for now.
//
// The 11-step pipeline:
//
//   1. Validate plan
//   2. Copy base image to working dir
//   3. losetup the working image (loop device)
//   4. Mount boot + rootfs partitions
//   5. Inject boot-partition files (dietpi.txt, Automation_*)
//   6. Bind-mount /dev, /proc, /sys into rootfs
//   7. Copy qemu-arm-static into rootfs/usr/bin/
//   8. chroot into rootfs, run apt-get install, enable services
//   9. Exit chroot, unmount, losetup --detach
//  10. Sanitise (drop logs, history, etc.)
//  11. Compress (xz) + checksum (sha256) + emit final paths
//
// All of those require: Linux (or Linux container), sudo, qemu-user-
// static. None are reachable from this browser-tooling Mac.
//
// When implemented, this file orchestrates via pipeline.mjs which
// runs each step as a child_process.exec, captures output, surfaces
// failures with the step ID that crashed.

export async function buildImage({ planPath, basePath, outDir }) {
  // Hard-stop guard until Phase 3 implementation lands.
  return {
    ok: false,
    error:
      'Image build is Phase 3 and not yet implemented. ' +
      'Phase 1 supports `ark-builder render` to produce dietpi.txt + ' +
      'Automation_Custom_Script.sh from a plan. See README for the full ' +
      'pipeline + system requirements.',
    planPath,
    basePath,
    outDir,
  };
}
