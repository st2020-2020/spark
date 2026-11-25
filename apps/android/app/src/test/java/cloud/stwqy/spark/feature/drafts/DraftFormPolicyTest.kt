package cloud.stwqy.spark.feature.drafts

import cloud.stwqy.spark.core.config.AppConfig
import cloud.stwqy.spark.core.storage.AssetUploadState
import cloud.stwqy.spark.core.storage.DraftAssetEntity
import cloud.stwqy.spark.core.storage.DraftContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DraftFormPolicyTest {
    @Test fun filledExtraOptionCountDetectsPrepopulatedFields() {
        assertEquals(0, filledExtraOptionCount(DraftContent("正文")))
        assertEquals(0, filledExtraOptionCount(DraftContent("正文", purpose = "  ", manualTitle = "\n")))
        assertEquals(1, filledExtraOptionCount(DraftContent("正文", purpose = "用于设计参考")))
        assertEquals(2, filledExtraOptionCount(DraftContent("正文", purpose = "参考", manualTitle = "标题")))
        assertEquals(3, filledExtraOptionCount(DraftContent("正文", purpose = "参考", manualTitle = "标题", excluded = true)))
    }

    @Test fun titleValidationCountsCodePointsAfterTrimming() {
        val exact = "字".repeat(AppConfig.MAX_TITLE_CODE_POINTS)
        assertTrue(isValidDraftTitle("  $exact  "))
        assertFalse(isValidDraftTitle("${exact}多"))
    }

    @Test fun disabledSaveReasonExplainsPriorityBlockers() {
        val importingAsset = DraftAssetEntity(
            id = "a1", draftId = "d1", localPath = "d1/a1", filename = "1.png",
            mimeType = "image/png", sizeBytes = 0, sortOrder = 0, uploadIdempotencyKey = "k1",
            uploadState = AssetUploadState.IMPORTING,
        )
        val failedAsset = importingAsset.copy(id = "a2", uploadState = AssetUploadState.IMPORT_FAILED)

        val readingUi = DraftUiState(
            images = listOf(DraftImage(importingAsset, null)),
            activeImageImports = setOf("a1"),
        )
        assertEquals("等待图片读取…", disabledSaveReason(readingUi, withinLimit = true, validTitle = true))

        val failedUi = DraftUiState(images = listOf(DraftImage(failedAsset, null)))
        assertEquals("请先重试或移除失败的图片", disabledSaveReason(failedUi, withinLimit = true, validTitle = true))

        val cleanUi = DraftUiState()
        assertEquals("正文与用途超出 50,000 字", disabledSaveReason(cleanUi, withinLimit = false, validTitle = true))
        assertEquals("标题超出 200 字", disabledSaveReason(cleanUi, withinLimit = true, validTitle = false))
        assertNull(disabledSaveReason(cleanUi, withinLimit = true, validTitle = true))
    }

    @Test fun closingStateLocksEditingSendingAndLogin() {
        val activeUi = DraftUiState(
            access = DraftAccess.VERIFIED,
            online = true,
            closing = CaptureClosing(generation = 1L, message = "已暂存到本机草稿"),
        )
        assertTrue(activeUi.isClosing)
        assertFalse(activeUi.canEdit)
        assertFalse(activeUi.canSend)
        assertFalse(activeUi.canLogin)
        assertFalse(activeUi.canChoose)
    }
}
