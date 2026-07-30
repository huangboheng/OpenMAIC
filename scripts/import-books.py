"""
Extract text from downloaded PDF/EPUB books and import into Philochora DB.
- Splits into paragraphs (50-500 chars)
- Replaces old placeholder content
- Creates translation tasks
"""
import os
import re
import sys
from pathlib import Path

import PyPDF2
from ebooklib import epub
from bs4 import BeautifulSoup
import psycopg2

DB_URL = "postgresql://postgres:882ab5346d3d5a8a15aba2d723aade19@localhost:5999/philochora"
DOWNLOAD_DIR = Path("E:/hermes/workspace/openmaic/data/book-downloads")
MAX_PARA_CHARS = 500
MIN_PARA_CHARS = 50
MAX_PARAGRAPHS = 500

# Map downloaded files to book IDs
FILE_BOOK_MAP = {
    "Mans Search For Meaning": 13070,
    "The Logic of Scientific Discovery": 13071,
    "The structure of scientific revolutions": 13072,
    "The Myth of Sisyphus": 13073,
    "Being and Nothingness": 13074,
    "Existentialism Is a Humanism": 13075,
    "The Burnout Society": 13076,
    "Anarchy, State, and Utopia": 13077,
    "Fear and Trembling": 13066,
    "Economic and Philosophic Manuscripts": 13067,
}


def extract_pdf(filepath):
    """Extract text from PDF file."""
    text = ""
    try:
        with open(filepath, "rb") as f:
            reader = PyPDF2.PdfReader(f)
            for page in reader.pages:
                page_text = page.extract_text()
                if page_text:
                    text += page_text + "\n\n"
    except Exception as e:
        print(f"  PDF error: {e}")
    return text


def extract_epub(filepath):
    """Extract text from EPUB file."""
    text = ""
    try:
        book = epub.read_epub(str(filepath), options={"ignore_ncx": True})
        for item in book.get_items():
            if item.get_type() == 9:  # ITEM_DOCUMENT
                soup = BeautifulSoup(item.get_content(), "html.parser")
                text += soup.get_text() + "\n\n"
    except Exception as e:
        print(f"  EPUB error: {e}")
    return text


def split_paragraphs(text, max_chars=MAX_PARA_CHARS, min_chars=MIN_PARA_CHARS):
    """Split text into paragraphs."""
    if not text:
        return []
    
    # Split by double newline
    raw_paras = re.split(r'\n\s*\n', text)
    
    result = []
    for p in raw_paras:
        p = p.replace('\r', '').replace('\n', ' ').strip()
        # Skip short/empty
        if len(p) < min_chars:
            continue
        # Skip non-content
        if p.startswith('***') or p.startswith('---'):
            continue
        
        if len(p) <= max_chars:
            result.append(p)
        else:
            # Split by sentence boundaries
            sentences = re.findall(r'[^.!?]+[.!?]+', p)
            if not sentences:
                sentences = [p]
            chunk = ""
            for s in sentences:
                if len(chunk) + len(s) > max_chars and chunk:
                    result.append(chunk.strip())
                    chunk = s
                else:
                    chunk += s
            if chunk.strip():
                result.append(chunk.strip())
    
    return result[:MAX_PARAGRAPHS]


def find_book_file(filename):
    """Match filename to book ID."""
    for pattern, book_id in FILE_BOOK_MAP.items():
        if pattern.lower() in filename.lower():
            return book_id
    return None


def main():
    conn = psycopg2.connect(DB_URL)
    cur = conn.cursor()
    
    files = list(DOWNLOAD_DIR.glob("*.pdf")) + list(DOWNLOAD_DIR.glob("*.epub"))
    print(f"Found {len(files)} book files\n")
    
    total_imported = 0
    
    for filepath in sorted(files):
        book_id = find_book_file(filepath.name)
        if not book_id:
            print(f"[SKIP] No book ID match: {filepath.name}")
            continue
        
        # Get book title
        cur.execute("SELECT title_zh, title_en FROM classics_books WHERE id = %s", (book_id,))
        row = cur.fetchone()
        if not row:
            print(f"[SKIP] Book ID {book_id} not in DB")
            continue
        title_zh, title_en = row
        
        print(f"[Processing] {title_zh} ({title_en}) - ID {book_id}")
        print(f"  File: {filepath.name} ({filepath.stat().st_size // 1024} KB)")
        
        # Extract text
        if filepath.suffix == '.pdf':
            text = extract_pdf(filepath)
        else:
            text = extract_epub(filepath)
        
        if not text or len(text) < 100:
            print(f"  WARNING: Extracted text too short ({len(text)} chars)")
            continue
        
        print(f"  Extracted: {len(text)} chars")
        
        # Split into paragraphs
        paragraphs = split_paragraphs(text)
        print(f"  Paragraphs: {len(paragraphs)}")
        
        if len(paragraphs) < 5:
            print(f"  WARNING: Too few paragraphs, skipping")
            continue
        
        # Delete old placeholder paragraphs
        cur.execute("""
            DELETE FROM translation_tasks 
            WHERE paragraph_id IN (
                SELECT id FROM classics_paragraphs 
                WHERE chapter_id IN (SELECT id FROM classics_chapters WHERE book_id = %s)
            )
        """, (book_id,))
        
        cur.execute("""
            DELETE FROM classics_paragraphs 
            WHERE chapter_id IN (SELECT id FROM classics_chapters WHERE book_id = %s)
        """, (book_id,))
        
        # Get chapter ID
        cur.execute("SELECT id FROM classics_chapters WHERE book_id = %s LIMIT 1", (book_id,))
        ch_row = cur.fetchone()
        if not ch_row:
            print(f"  ERROR: No chapter found for book {book_id}")
            continue
        chapter_id = ch_row[0]
        
        # Insert new paragraphs
        for i, para in enumerate(paragraphs):
            cur.execute("""
                INSERT INTO classics_paragraphs (chapter_id, paragraph_number, content_en, content_zh, sort_order)
                VALUES (%s, %s, %s, %s, %s)
                RETURNING id
            """, (chapter_id, i + 1, para, para, i))
            para_id = cur.fetchone()[0]
            
            # Create translation task
            cur.execute("""
                INSERT INTO translation_tasks (paragraph_id, book_id, chapter_id, status, priority_tier)
                VALUES (%s, %s, %s, 'pending', 'P3')
                ON CONFLICT (paragraph_id) DO NOTHING
            """, (para_id, book_id, chapter_id))
        
        # Update book metadata
        cur.execute("""
            UPDATE classics_books 
            SET total_chapters = (SELECT COUNT(*) FROM classics_chapters WHERE book_id = %s)
            WHERE id = %s
        """, (book_id, book_id))
        
        conn.commit()
        total_imported += len(paragraphs)
        print(f"  Imported {len(paragraphs)} paragraphs + translation tasks\n")
    
    print(f"{'='*60}")
    print(f"  Total imported: {total_imported} paragraphs")
    print(f"{'='*60}")
    
    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
