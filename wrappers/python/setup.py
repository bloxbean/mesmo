"""Build config for platform-specific wheels that bundle the native library.

Metadata lives in pyproject.toml; this file only exists to (a) force a platform-tagged wheel — the
package ships a prebuilt `libmesmo.*` under `mesmo/_libs/`, so a wheel is not portable across OS/arch —
and (b) tag it `py3-none-<platform>` since the binding is pure-Python ctypes (works on any Python 3),
only the bundled binary is platform-specific.
"""
from setuptools import setup
from setuptools.dist import Distribution

try:  # setuptools >= 70.1 vendors bdist_wheel
    from setuptools.command.bdist_wheel import bdist_wheel as _bdist_wheel
except ImportError:  # older setuptools: from the `wheel` package
    from wheel.bdist_wheel import bdist_wheel as _bdist_wheel


class BinaryDistribution(Distribution):
    """Marks the distribution as non-pure so the wheel gets a platform tag."""

    def has_ext_modules(self):
        return True


class bdist_wheel(_bdist_wheel):
    def finalize_options(self):
        super().finalize_options()
        self.root_is_pure = False

    def get_tag(self):
        # Any Python 3, no C-ABI, platform fixed by the bundled native library.
        _, _, plat = super().get_tag()
        return "py3", "none", plat


setup(
    distclass=BinaryDistribution,
    cmdclass={"bdist_wheel": bdist_wheel},
    packages=["mesmo"],
    package_data={"mesmo": ["_libs/*"]},
    include_package_data=True,
)
