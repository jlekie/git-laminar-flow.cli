export enum StatusTypes {
    Unknown,
    Untracked,
    Modified,
    Added,
    Deleted,
    Renamed,
    Copied
}
export interface Status {
    staged: boolean;
    type: StatusTypes;
    isSubmodule: boolean;
    path: string;
}

export function parseStatus(value: string) {
    const [ code, ...rest ] = value.split(' ');

    if (code === '?') {
        const path = rest.join(' ');

        return {
            type: StatusTypes.Untracked,
            path
        }
    }
    else {
        const [ rawGitType, fileType, , , , , , ...innerRest ] = rest;
        const path = innerRest.join(' ');

        const [ staged, gitTypeCode ] = rawGitType[0] !== '.' ? [ true, rawGitType[0] ] : [ false, rawGitType[1] ];
        const statusType = (() => {
            switch (gitTypeCode) {
                case 'M': return StatusTypes.Modified;
                case 'A': return StatusTypes.Added;
                case 'D': return StatusTypes.Deleted;
                case 'R': return StatusTypes.Renamed;
                case 'C': return StatusTypes.Copied;
                default: return StatusTypes.Unknown;
            }
        })();

        const isSubmodule = fileType[0] === 'S';

        return {
            type: statusType,
            staged,
            path,
            isSubmodule
        }
    }
}
