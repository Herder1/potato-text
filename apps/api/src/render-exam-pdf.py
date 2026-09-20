import base64
import io
import json
import os
import sys
import gzip

from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas


def find_font():
    configured = os.environ.get("SHUKAO_PDF_FONT_PATH", "").strip()
    candidates = [
        configured,
        r"C:\Windows\Fonts\STSONG.TTF",
        r"C:\Windows\Fonts\simhei.ttf",
        r"C:\Windows\Fonts\NotoSansSC-VF.ttf",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
        "/System/Library/Fonts/PingFang.ttc",
    ]
    for candidate in candidates:
        if candidate and os.path.isfile(candidate):
            return candidate
    raise RuntimeError("exam_export_cjk_font_unavailable")


def register_font():
    font_path = find_font()
    try:
        pdfmetrics.registerFont(TTFont("ShuKaoCJK", font_path, subfontIndex=0))
    except TypeError:
        pdfmetrics.registerFont(TTFont("ShuKaoCJK", font_path))
    return "ShuKaoCJK"


def draw_text(pdf, font_name, text, x, top_y, font_size, page_height, bold=False, gray=0):
    pdf.setFillGray(float(gray or 0))
    y = page_height - float(top_y)
    text_object = pdf.beginText(float(x), y)
    text_object.setFont(font_name, float(font_size))
    if bold:
        pdf.setStrokeGray(float(gray or 0))
        pdf.setLineWidth(0.22)
        text_object.setTextRenderMode(2)
    text_object.textOut(str(text))
    pdf.drawText(text_object)


def render_layout(layout, font_name):
    page_width = float(layout.get("pageWidth") or 595.28)
    page_height = float(layout.get("pageHeight") or 841.89)
    output = io.BytesIO()
    pdf = canvas.Canvas(
        output,
        pagesize=(page_width, page_height),
        pageCompression=1,
        pdfVersion=(1, 7),
    )
    pdf.setTitle("ShuKao Exam")
    pdf.setAuthor("ShuKao")
    pdf.setCreator("ShuKao PDF Renderer")
    pdf.setSubject("Exam paper and answer")
    pdf.setKeywords("ShuKao, exam")
    pdf._doc.info.producer = "ReportLab"
    pages = layout.get("pages") or [[]]
    for page_index, operations in enumerate(pages):
        watermark = str(layout.get("watermarkText") or "薯考")
        pdf.saveState()
        try:
            pdf.setFillAlpha(0.08)
        except Exception:
            pdf.setFillGray(0.92)
        pdf.setFont(font_name, 54)
        pdf.translate(page_width / 2, page_height / 2)
        pdf.rotate(45)
        pdf.drawCentredString(0, 0, watermark)
        pdf.restoreState()

        header = str(layout.get("headerText") or "更多汉语言插本文学资讯，请关注公众号：汉化土豆")
        pdf.setFont(font_name, 9.5)
        pdf.setFillGray(0.1)
        pdf.drawCentredString(page_width / 2, page_height - 55, header)
        margin_x = float(layout.get("marginX") or 90)
        pdf.setStrokeGray(0.15)
        pdf.setLineWidth(0.55)
        pdf.line(margin_x, page_height - 70, page_width - margin_x, page_height - 70)

        for operation in operations:
            if operation.get("type") == "line":
                pdf.setStrokeGray(float(operation.get("gray") or 0))
                pdf.setLineWidth(float(operation.get("width") or 0.5))
                pdf.line(
                    float(operation.get("x1") or 0),
                    page_height - float(operation.get("y1") or 0),
                    float(operation.get("x2") or 0),
                    page_height - float(operation.get("y2") or 0),
                )
            else:
                draw_text(
                    pdf,
                    font_name,
                    operation.get("text") or "",
                    operation.get("x") or 0,
                    operation.get("y") or 0,
                    operation.get("fontSize") or 12,
                    page_height,
                    operation.get("bold") is True,
                    operation.get("gray") or 0,
                )

        pdf.setFillGray(0.15)
        pdf.setFont(font_name, 9.5)
        pdf.drawCentredString(page_width / 2, 25.89, f"第 {page_index + 1} 页，共 {len(pages)} 页")
        pdf.showPage()
    pdf.save()
    return output.getvalue()


def main():
    compressed = base64.b64decode(sys.stdin.read().strip())
    payload = json.loads(gzip.decompress(compressed).decode("utf-8"))
    font_name = register_font()
    rendered = [base64.b64encode(render_layout(layout, font_name)).decode("ascii") for layout in payload.get("layouts", [])]
    sys.stdout.write(json.dumps({"pdfs": rendered}, ensure_ascii=True))


if __name__ == "__main__":
    main()
