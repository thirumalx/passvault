import java.io.File
import org.apache.tools.ant.taskdefs.condition.Os
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.logging.LogLevel
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.TaskAction

open class BuildTask : DefaultTask() {
    @Input
    var rootDirRel: String? = null
    @Input
    var target: String? = null
    @Input
    var release: Boolean? = null

    @TaskAction
    fun assemble() {
        val rootDirRel = rootDirRel ?: throw GradleException("rootDirRel cannot be null")
        val target = target ?: throw GradleException("target cannot be null")
        val isRelease = release == true
        val targetDir = when (target) {
            "aarch64" -> "aarch64-linux-android"
            "armv7" -> "armv7-linux-androideabi"
            "i686" -> "i686-linux-android"
            "x86_64" -> "x86_64-linux-android"
            else -> target
        }
        val abi = when (target) {
            "aarch64" -> "arm64-v8a"
            "armv7" -> "armeabi-v7a"
            "i686" -> "x86"
            "x86_64" -> "x86_64"
            else -> "arm64-v8a"
        }
        val profile = if (isRelease) "release" else "debug"
        val rootDir = File(project.projectDir, rootDirRel)
        val jniDir = File(project.projectDir, "src/main/jniLibs/$abi")
        val destSo = File(jniDir, "libpassvault_lib.so")

        // Check if already in jniLibs or locate in cargo target
        if (destSo.exists() && destSo.length() > 0) {
            println("BuildTask: Using existing library at $destSo (${destSo.length()} bytes)")
            return
        }

        val candidates = listOf(
            File(rootDir, "target/$targetDir/$profile/libpassvault_lib.so"),
            File(rootDir, "src-tauri/target/$targetDir/$profile/libpassvault_lib.so"),
            File(project.rootDir, "../../src-tauri/target/$targetDir/$profile/libpassvault_lib.so")
        )

        for (candidate in candidates) {
            if (candidate.exists()) {
                jniDir.mkdirs()
                candidate.copyTo(destSo, overwrite = true)
                println("BuildTask: Copied $candidate to $destSo (${destSo.length()} bytes)")
                return
            }
        }

        println("BuildTask: Warning - could not find pre-built .so in candidate paths")
    }
}
