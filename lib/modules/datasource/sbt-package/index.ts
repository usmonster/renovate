import { XmlDocument } from 'xmldoc';
import { logger } from '../../../logger';
import { Http } from '../../../util/http';
import { regEx } from '../../../util/regex';
import { ensureTrailingSlash } from '../../../util/url';
import * as ivyVersioning from '../../versioning/ivy';
import { compare } from '../../versioning/maven/compare';
import { MavenDatasource } from '../maven';
import { MAVEN_REPO } from '../maven/common';
import { downloadHttpProtocol } from '../maven/util';
import type {
  GetReleasesConfig,
  RegistryStrategy,
  ReleaseResult,
} from '../types';
import { extractPageLinks, getLatestVersion } from './util';

export class SbtPackageDatasource extends MavenDatasource {
  static override id = 'sbt-package';

  override readonly defaultRegistryUrls = [MAVEN_REPO];

  override readonly defaultVersioning = ivyVersioning.id;

  override readonly registryStrategy: RegistryStrategy = 'hunt';

  override readonly sourceUrlSupport = 'package';
  override readonly sourceUrlNote =
    'The source URL is determined from the `scm` tags in the results.';

  constructor(id = SbtPackageDatasource.id) {
    super(id);
    this.http = new Http('sbt');
  }

  async getArtifactSubdirs(
    searchRoot: string,
    artifact: string,
    scalaVersion: string,
  ): Promise<string[] | null> {
    const pkgUrl = ensureTrailingSlash(searchRoot);
    const res = await downloadHttpProtocol(this.http, pkgUrl);
    const indexContent = res?.body;
    if (indexContent) {
      const rootPath = new URL(pkgUrl).pathname;
      let artifactSubdirs = extractPageLinks(indexContent, (href) => {
        const path = href.replace(rootPath, '');
        if (
          path.startsWith(`${artifact}_native`) ||
          path.startsWith(`${artifact}_sjs`)
        ) {
          return null;
        }

        if (path === artifact || path.startsWith(`${artifact}_`)) {
          return path;
        }

        return null;
      });

      if (
        scalaVersion &&
        artifactSubdirs.includes(`${artifact}_${scalaVersion}`)
      ) {
        artifactSubdirs = [`${artifact}_${scalaVersion}`];
      }
      return artifactSubdirs;
    }

    return null;
  }

  async getPackageReleases(
    searchRoot: string,
    artifactSubdirs: string[] | null,
  ): Promise<string[] | null> {
    if (artifactSubdirs) {
      const releases: string[] = [];
      for (const searchSubdir of artifactSubdirs) {
        const pkgUrl = ensureTrailingSlash(`${searchRoot}/${searchSubdir}`);
        const res = await downloadHttpProtocol(this.http, pkgUrl);
        const content = res?.body;
        if (content) {
          const rootPath = new URL(pkgUrl).pathname;
          const subdirReleases = extractPageLinks(content, (href) => {
            const path = href.replace(rootPath, '');
            if (path.startsWith('.')) {
              return null;
            }

            return path;
          });

          subdirReleases.forEach((x) => releases.push(x));
        }
      }
      if (releases.length) {
        return [...new Set(releases)].sort(compare);
      }
    }

    return null;
  }

  async getUrls(
    searchRoot: string,
    artifactDirs: string[] | null,
    version: string | null,
  ): Promise<Partial<ReleaseResult>> {
    const result: Partial<ReleaseResult> = {};

    if (!artifactDirs?.length) {
      return result;
    }

    if (!version) {
      return result;
    }

    for (const artifactDir of artifactDirs) {
      const [artifact] = artifactDir.split('_');
      const pomFileNames = [
        `${artifactDir}-${version}.pom`,
        `${artifact}-${version}.pom`,
      ];

      for (const pomFileName of pomFileNames) {
        const pomUrl = `${searchRoot}/${artifactDir}/${version}/${pomFileName}`;
        const res = await downloadHttpProtocol(this.http, pomUrl);
        const content = res?.body;
        if (content) {
          const pomXml = new XmlDocument(content);

          const homepage = pomXml.valueWithPath('url');
          if (homepage) {
            result.homepage = homepage;
          }

          const sourceUrl = pomXml.valueWithPath('scm.url');
          if (sourceUrl) {
            result.sourceUrl = sourceUrl
              .replace(regEx(/^scm:/), '')
              .replace(regEx(/^git:/), '')
              .replace(regEx(/^git@github.com:/), 'https://github.com/')
              .replace(regEx(/\.git$/), '');
          }

          return result;
        }
      }
    }

    return result;
  }

  override async getReleases(
    config: GetReleasesConfig,
  ): Promise<ReleaseResult | null> {
    const { packageName, registryUrl } = config;
    // istanbul ignore if
    if (!registryUrl) {
      return null;
    }

    const [groupId, artifactId] = packageName.split(':');
    const groupIdSplit = groupId.split('.');
    const artifactIdSplit = artifactId.split('_');
    const [artifact, scalaVersion] = artifactIdSplit;

    const repoRoot = ensureTrailingSlash(registryUrl);
    const searchRoots: string[] = [];
    // Optimize lookup order
    searchRoots.push(`${repoRoot}${groupIdSplit.join('/')}`);
    searchRoots.push(`${repoRoot}${groupIdSplit.join('.')}`);

    for (let idx = 0; idx < searchRoots.length; idx += 1) {
      const searchRoot = searchRoots[idx];
      const artifactSubdirs = await this.getArtifactSubdirs(
        searchRoot,
        artifact,
        scalaVersion,
      );
      const versions = await this.getPackageReleases(
        searchRoot,
        artifactSubdirs,
      );
      const latestVersion = getLatestVersion(versions);
      const urls = await this.getUrls(
        searchRoot,
        artifactSubdirs,
        latestVersion,
      );

      const dependencyUrl = searchRoot;

      logger.trace({ dependency: packageName, versions }, `Package versions`);
      if (versions) {
        return {
          ...urls,
          dependencyUrl,
          releases: versions.map((v) => ({ version: v })),
        };
      }
    }

    logger.debug(
      `No versions discovered for ${packageName} listing organization root package folder, fallback to maven datasource for version discovery`,
    );
    const mavenReleaseResult = await super.getReleases(config);
    if (mavenReleaseResult) {
      return mavenReleaseResult;
    }

    logger.debug(
      `No versions found for ${packageName} in ${searchRoots.length} repositories`,
    );
    return null;
  }
}
