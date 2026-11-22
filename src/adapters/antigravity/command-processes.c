#include <errno.h>
#include <libproc.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc.h>
#include <unistd.h>

// The macOS SDK does not declare sandbox_check or its query filters.
extern int sandbox_check(pid_t pid, const char *operation, int filter, ...);
static const int global_name_no_report = 2 | 0x40000000;

static int belongs_to_command(pid_t pid, const char *scope, const char *control) {
    return sandbox_check(pid, "mach-lookup", global_name_no_report, scope) == 1 &&
           sandbox_check(pid, "mach-lookup", global_name_no_report, control) == 0;
}

static int stop_commands(const char *scope, const char *control) {
    const int needed = proc_listpids(PROC_UID_ONLY, getuid(), NULL, 0);
    if (needed <= 0) return -1;
    const int size = needed + 64 * sizeof(pid_t);
    pid_t *pids = malloc(size);
    if (pids == NULL) return -1;
    const int bytes = proc_listpids(PROC_UID_ONLY, getuid(), pids, size);
    if (bytes <= 0 || bytes >= size) {
        free(pids);
        return -1;
    }

    int stopped = 0;
    for (size_t i = 0; i < (size_t)bytes / sizeof(pid_t); i++) {
        const pid_t pid = pids[i];
        struct proc_bsdinfo before, current;
        if (pid <= 1 || proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &before, sizeof(before)) != sizeof(before) ||
            before.pbi_status == SZOMB || !belongs_to_command(pid, scope, control)) continue;
        if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &current, sizeof(current)) != sizeof(current) ||
            current.pbi_start_tvsec != before.pbi_start_tvsec || current.pbi_start_tvusec != before.pbi_start_tvusec) continue;
        if (kill(pid, SIGKILL) == 0) stopped++;
        else if (errno != ESRCH) {
            perror("kill");
            free(pids);
            return -1;
        }
    }
    free(pids);
    return stopped;
}

int main(int argc, char **argv) {
    if (argc != 3) return 2;
    const char *scope = argv[2];
    char control[128];
    if (snprintf(control, sizeof(control), "%s.control", scope) >= (int)sizeof(control)) return 2;
    if (strcmp(argv[1], "probe") == 0) return belongs_to_command(getpid(), scope, control) ? 0 : 1;
    if (strcmp(argv[1], "stop") != 0) return 2;

    for (;;) {
        const int stopped = stop_commands(scope, control);
        if (stopped < 0) {
            fputs("无法枚举或停止 Antigravity 命令进程\n", stderr);
            return 1;
        }
        if (stopped == 0) return 0;
        usleep(10000);
    }
}
