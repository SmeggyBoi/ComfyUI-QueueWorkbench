"""
Serve a finished output as a download (Content-Disposition: attachment), so a phone's browser
saves it straight away instead of displaying it. Used by the notification's Save button.
Same path rules as ComfyUI's /view; kept free of ComfyUI imports so it can be tested alone.
"""
import mimetypes
import os
import urllib.parse


def resolve(filename, subfolder, ftype, directory_by_type):
    """(200, absolute path) of an output file, or (400 / 403 / 404, None)."""
    if not filename or filename[0] == "/" or ".." in filename:
        return 400, None
    base = directory_by_type(ftype)
    if base is None:
        return 400, None
    base = os.path.abspath(base)
    folder = os.path.abspath(os.path.join(base, subfolder)) if subfolder else base
    if os.path.commonpath((folder, base)) != base:
        return 403, None
    path = os.path.join(folder, os.path.basename(filename))
    return (200, path) if os.path.isfile(path) else (404, None)


def headers(filename):
    """The real content type (so the phone files it as a picture or video) plus an attachment
    disposition: plain-ASCII filename for old clients, filename* for the exact name."""
    content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    ascii_name = filename.encode("ascii", "replace").decode().replace("\\", "\\\\").replace('"', '\\"')
    disposition = f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{urllib.parse.quote(filename)}"
    return {"Content-Type": content_type, "Content-Disposition": disposition, "X-Content-Type-Options": "nosniff"}
