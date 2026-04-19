"""Route blueprints."""
from .compositions import compositions_bp
from .exports import exports_bp
from .library import library_bp
from .scanners import scanners_bp
from .segments import segments_bp
from .subtitles import subtitles_bp
from .videos import videos_bp

ALL_BLUEPRINTS = (
    library_bp,
    videos_bp,
    segments_bp,
    scanners_bp,
    subtitles_bp,
    compositions_bp,
    exports_bp,
)
