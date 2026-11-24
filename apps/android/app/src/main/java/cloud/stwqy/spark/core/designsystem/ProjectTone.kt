package cloud.stwqy.spark.core.designsystem

import kotlin.math.abs

fun projectToneIndex(projectId: String): Int {
    var hash = 0
    for (unit in projectId) {
        hash = hash * 31 + unit.code
    }
    return (abs(hash.toLong()) % 6L).toInt() + 1
}
