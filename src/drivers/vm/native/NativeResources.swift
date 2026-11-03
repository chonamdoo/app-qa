import Foundation
import Darwin

enum NativeResources {
    static func availableMemoryMiB() throws -> Int {
        let host = mach_host_self()
        defer { mach_port_deallocate(mach_task_self_, host) }
        var pageSize: vm_size_t = 0
        guard host_page_size(host, &pageSize) == KERN_SUCCESS, pageSize > 0 else {
            throw NativeFault("host_memory_unavailable", "Cannot read the host memory page size")
        }
        var statistics = vm_statistics64_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<vm_statistics64_data_t>.size / MemoryLayout<integer_t>.size)
        let result = withUnsafeMutablePointer(to: &statistics) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                host_statistics64(host, HOST_VM_INFO64, $0, &count)
            }
        }
        guard result == KERN_SUCCESS else {
            throw NativeFault("host_memory_unavailable", "Cannot read host reclaimable memory counters")
        }
        // mach/vm_statistics.h already includes speculative pages in free_count.
        let reclaimable = (UInt64(statistics.free_count) + UInt64(statistics.inactive_count)) * UInt64(pageSize)
        return Int(min(reclaimable, ProcessInfo.processInfo.physicalMemory) / 1_048_576)
    }
}
