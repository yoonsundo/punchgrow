#include <errno.h>
#include <libproc.h>
#include <mach/mach_time.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/resource.h>
#include <time.h>
#include <unistd.h>

/*
 * Low-overhead 1 Hz sampler for the running menu-bar app:
 *   clang -O2 scripts/punchgrow-rusage.c -o /tmp/punchgrow-rusage
 *   /tmp/punchgrow-rusage "$(pgrep -xo PunchGrowMenuBar)" 600 > /tmp/punchgrow.csv
 *
 * cpu_percent is relative to one core. proc_pid_rusage reports CPU time in
 * Mach ticks, so the conversion below must use the host timebase.
 */
static volatile sig_atomic_t should_stop = 0;

static void stop_sampling(int signal_number) {
  (void)signal_number;
  should_stop = 1;
}

static double monotonic_seconds(void) {
  struct timespec time;
  if (clock_gettime(CLOCK_MONOTONIC, &time) != 0) {
    perror("clock_gettime");
    exit(1);
  }
  return (double)time.tv_sec + (double)time.tv_nsec / 1e9;
}

static long parse_positive_long(const char *value, const char *label) {
  char *end = NULL;
  errno = 0;
  long parsed = strtol(value, &end, 10);
  if (errno != 0 || end == value || *end != '\0' || parsed <= 0) {
    fprintf(stderr, "%s must be a positive integer: %s\n", label, value);
    exit(64);
  }
  return parsed;
}

static int read_usage(pid_t pid, struct rusage_info_v4 *usage) {
  if (proc_pid_rusage(pid, RUSAGE_INFO_V4, (rusage_info_t *)usage) == 0) {
    return 0;
  }
  fprintf(stderr, "proc_pid_rusage failed for PID %d: ", pid);
  perror(NULL);
  return 1;
}

int main(int argc, char **argv) {
  if (argc != 3) {
    fprintf(stderr, "usage: %s <pid> <sample-count>\n", argv[0]);
    return 64;
  }

  long parsed_pid = parse_positive_long(argv[1], "pid");
  long sample_count = parse_positive_long(argv[2], "sample-count");
  if ((pid_t)parsed_pid != parsed_pid) {
    fprintf(stderr, "pid is out of range: %s\n", argv[1]);
    return 64;
  }
  pid_t pid = (pid_t)parsed_pid;

  signal(SIGINT, stop_sampling);
  signal(SIGTERM, stop_sampling);

  puts("elapsed_s,cpu_percent,footprint_bytes,resident_bytes,peak_footprint_bytes,"
       "read_delta,write_delta,idle_wakeup_delta,interrupt_wakeup_delta");

  struct rusage_info_v4 previous = {0};
  struct rusage_info_v4 current = {0};
  mach_timebase_info_data_t timebase = {0};
  if (mach_timebase_info(&timebase) != KERN_SUCCESS || timebase.denom == 0) {
    fputs("mach_timebase_info failed\n", stderr);
    return 1;
  }
  if (read_usage(pid, &previous) != 0) {
    return 1;
  }
  double started_at = monotonic_seconds();
  double previous_at = started_at;

  for (long sample = 0; sample < sample_count && !should_stop; sample += 1) {
    unsigned int remaining = sleep(1);
    if (remaining > 0 && should_stop) {
      break;
    }

    double sampled_at = monotonic_seconds();
    if (read_usage(pid, &current) != 0) {
      return 1;
    }
    double interval = sampled_at - previous_at;
    uint64_t cpu_ticks =
        (current.ri_user_time - previous.ri_user_time) +
        (current.ri_system_time - previous.ri_system_time);
    double cpu_nanoseconds =
        (double)cpu_ticks * (double)timebase.numer / (double)timebase.denom;
    double cpu_percent = interval > 0
                             ? 100.0 * (double)cpu_nanoseconds / 1e9 / interval
                             : 0;

    printf("%.3f,%.4f,%llu,%llu,%llu,%llu,%llu,%llu,%llu\n",
           sampled_at - started_at, cpu_percent,
           current.ri_phys_footprint, current.ri_resident_size,
           current.ri_lifetime_max_phys_footprint,
           current.ri_diskio_bytesread - previous.ri_diskio_bytesread,
           current.ri_diskio_byteswritten - previous.ri_diskio_byteswritten,
           current.ri_pkg_idle_wkups - previous.ri_pkg_idle_wkups,
           current.ri_interrupt_wkups - previous.ri_interrupt_wkups);
    fflush(stdout);

    previous = current;
    previous_at = sampled_at;
  }

  return 0;
}
