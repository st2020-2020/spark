package cloud.stwqy.spark.core.designsystem

import org.junit.Assert.assertEquals
import org.junit.Test

class ProjectToneTest {
    @Test fun matchesWebUtf16HashForEveryTone() {
        val samples = mapOf(
            "" to 1, "a" to 2, "b" to 3, "c" to 4, "d" to 5, "e" to 6, "f" to 1,
            "项目💡" to 4, "00000000-0000-4000-8000-000000000001" to 6,
        )
        for ((id, tone) in samples) assertEquals(id, tone, projectToneIndex(id))
    }

    @Test fun minimumIntHashIsWidenedBeforeAbsoluteValue() {
        val id = "polygenelubricants"
        assertEquals(Int.MIN_VALUE, id.hashCode())
        assertEquals(3, projectToneIndex(id))
    }
}
