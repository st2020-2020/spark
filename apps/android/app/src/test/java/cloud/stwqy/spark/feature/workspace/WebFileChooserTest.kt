package cloud.stwqy.spark.feature.workspace

import org.junit.Assert.assertEquals
import org.junit.Test

class WebFileChooserTest {
    @Test fun acceptsBothCsvMimeTypesUsedByDocumentProviders() {
        val csvTypes = listOf("text/csv", "text/comma-separated-values")
        assertEquals(csvTypes, documentMimeTypes(listOf(".csv", "text/csv")))
        assertEquals(csvTypes, documentMimeTypes(listOf("text/comma-separated-values")))
        assertEquals(listOf("application/pdf"), documentMimeTypes(listOf("application/pdf")))
        assertEquals(listOf("*/*"), documentMimeTypes(emptyList()))
    }
}
